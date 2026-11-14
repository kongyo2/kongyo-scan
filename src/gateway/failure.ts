import { sanitizeLine } from "../core/errors.js";
import type { FailureKind, UpstreamFailure } from "./types.js";

const MAX_MESSAGE = 300;

interface ParsedError {
  message: string | undefined;
  code: string | undefined;
  type: string | undefined;
}

/** Pull the message and code out of the error shapes OpenAI-compatible endpoints use. */
export function parseErrorBody(text: string): ParsedError {
  const trimmed = text.trim();
  if (trimmed === "") return { message: undefined, code: undefined, type: undefined };
  try {
    const body = JSON.parse(trimmed) as unknown;
    return parseErrorValue(body);
  } catch {
    // HTML or plain text. Keep a short excerpt; strip tags so an error page stays readable.
    const plain = trimmed.replaceAll(/<[^>]*>/gu, " ");
    return { message: plain, code: undefined, type: undefined };
  }
}

export function parseErrorValue(body: unknown): ParsedError {
  if (typeof body === "string") return { message: body, code: undefined, type: undefined };
  if (body === null || typeof body !== "object") {
    return { message: undefined, code: undefined, type: undefined };
  }
  const record = body as Record<string, unknown>;
  const nested = record["error"];
  if (typeof nested === "string") {
    return { message: nested, code: asString(record["code"]), type: asString(record["type"]) };
  }
  const source =
    nested !== null && typeof nested === "object" ? (nested as Record<string, unknown>) : record;
  const message =
    asString(source["message"]) ??
    asString(source["detail"]) ??
    asString(source["msg"]) ??
    asString(record["message"]);
  const code = source["code"];
  return {
    message,
    code: typeof code === "string" ? code : typeof code === "number" ? String(code) : undefined,
    type: asString(source["type"]),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

const CONTEXT_PATTERN =
  /context[ _-]?(?:length|window)|maximum context|max(?:imum)? (?:input )?tokens|too many (?:input )?tokens|prompt is too long|input is too long|exceeds? the (?:model'?s? )?(?:context|token)|reduce the length|token limit exceeded|request too large for model/iu;
const QUOTA_PATTERN =
  /insufficient[ _]quota|quota (?:exceeded|exhausted)|out of credits?|insufficient (?:balance|credits?|funds)|billing|payment required|credit balance|spend(?:ing)? limit|usage limit|allowance/iu;
const RATE_LIMIT_PATTERN =
  /rate[ _-]?limit|too many requests|requests? per (?:min|minute|second)|concurren(?:t|cy)[ -](?:request|limit)/iu;
const QUOTA_CODES = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "billing_not_active",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "usage_limit_reached",
]);

export function isContextLength(parsed: ParsedError): boolean {
  if (parsed.code && /context_length|context_window|string_above_max_length/iu.test(parsed.code))
    return true;
  return parsed.message !== undefined && CONTEXT_PATTERN.test(parsed.message);
}

/** Read `Retry-After` (seconds or HTTP date) or a "try again in 2s" hint from the message. */
export function retryAfterMs(
  headerValue: string | null | undefined,
  message?: string,
): number | undefined {
  if (headerValue) {
    const seconds = Number(headerValue);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const date = Date.parse(headerValue);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const match = message
    ? /try again in\s*(\d+(?:\.\d+)?)\s*(ms|s|seconds?|m|minutes?)/iu.exec(message)
    : null;
  if (match) {
    const value = Number(match[1]);
    const unit = match[2]!.toLowerCase();
    if (unit === "ms") return Math.round(value);
    if (unit.startsWith("m")) return Math.round(value * 60_000);
    return Math.round(value * 1000);
  }
  return undefined;
}

/** Classify an HTTP error response from an endpoint. */
export function classifyHttpFailure(
  provider: string,
  status: number,
  bodyText: string,
  retryAfterHeader?: string | null,
): UpstreamFailure {
  const parsed = parseErrorBody(bodyText);
  const detail = parsed.message ?? `HTTP ${status}`;
  let kind: FailureKind;
  if (isContextLength(parsed)) kind = "context_length";
  else if (status === 401 || status === 403) kind = isQuota(parsed) ? "quota" : "auth";
  else if (status === 402) kind = "quota";
  else if (status === 429) kind = isQuota(parsed) ? "quota" : "rate_limit";
  else if (status === 404) kind = "not_found";
  else if (status === 408 || status === 504) kind = "timeout";
  else if (status >= 500) kind = "server";
  else if (parsed.code === "model_not_found") kind = "not_found";
  else kind = "bad_request";
  return {
    provider,
    kind,
    status,
    code: parsed.code,
    message: clip(`${status} ${detail}`),
    retryAfterMs:
      kind === "rate_limit" ? retryAfterMs(retryAfterHeader, parsed.message) : undefined,
  };
}

function isQuota(parsed: ParsedError): boolean {
  if (parsed.code && QUOTA_CODES.has(parsed.code)) return true;
  if (parsed.type && QUOTA_CODES.has(parsed.type)) return true;
  return parsed.message !== undefined && QUOTA_PATTERN.test(parsed.message);
}

/** Classify an error object that arrived inside a stream (`response.failed`, `error`, or a chat chunk). */
export function classifyStreamError(provider: string, error: unknown): UpstreamFailure {
  const parsed = parseErrorValue(error);
  const message = parsed.message ?? "The endpoint reported an error.";
  let kind: FailureKind = "server";
  if (isContextLength(parsed)) kind = "context_length";
  else if (isQuota(parsed)) kind = "quota";
  else if (
    (parsed.code && /rate_limit|slow_down|too_many_requests/iu.test(parsed.code)) ||
    (parsed.message !== undefined && RATE_LIMIT_PATTERN.test(parsed.message))
  ) {
    kind = "rate_limit";
  } else if (parsed.code && /invalid_api_key|authentication|unauthorized/iu.test(parsed.code))
    kind = "auth";
  else if (parsed.code === "model_not_found") kind = "not_found";
  else if (parsed.code && /invalid_request|invalid_prompt|bad_request/iu.test(parsed.code))
    kind = "bad_request";
  return {
    provider,
    kind,
    status: undefined,
    code: parsed.code,
    message: clip(message),
    retryAfterMs: kind === "rate_limit" ? retryAfterMs(undefined, parsed.message) : undefined,
  };
}

/** Classify a thrown transport error (DNS, TLS, refused connection, timeout, abort). */
export function classifyTransportFailure(
  provider: string,
  error: unknown,
  timedOut: boolean,
): UpstreamFailure {
  const chain: string[] = [];
  let code: string | undefined;
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 5; depth++) {
    if (current.message && !chain.includes(current.message)) chain.push(current.message);
    const candidate = (current as NodeJS.ErrnoException).code;
    if (typeof candidate === "string" && code === undefined) code = candidate;
    current = current.cause;
  }
  const isTimeout =
    timedOut ||
    (code !== undefined && /TIMEOUT|ETIMEDOUT/u.test(code)) ||
    chain.some((text) => /timed? ?out/iu.test(text));
  const detail =
    chain.filter((text) => text !== "fetch failed").join(": ") || "The connection failed.";
  return {
    provider,
    kind: isTimeout ? "timeout" : "network",
    status: undefined,
    code,
    message: clip(isTimeout && timedOut ? "No response before the timeout." : detail),
    retryAfterMs: undefined,
  };
}

export function protocolFailure(provider: string, message: string): UpstreamFailure {
  return {
    provider,
    kind: "protocol",
    status: undefined,
    code: undefined,
    message: clip(message),
    retryAfterMs: undefined,
  };
}

function clip(text: string): string {
  const line = sanitizeLine(text);
  return line.length > MAX_MESSAGE ? `${line.slice(0, MAX_MESSAGE - 1)}…` : line;
}

/** Failures that are about this one request rather than the provider's health. */
export function isRequestSpecific(kind: FailureKind): boolean {
  return kind === "context_length" || kind === "bad_request";
}

/** How long to skip a provider after a failure, in milliseconds. */
export function cooldownFor(failure: UpstreamFailure, defaultCooldownMs: number): number {
  switch (failure.kind) {
    case "context_length":
    case "bad_request":
      return 0;
    case "rate_limit":
      return Math.max(failure.retryAfterMs ?? 0, Math.min(defaultCooldownMs, 30_000));
    case "auth":
    case "quota":
    case "not_found":
      // These do not heal on their own within a scan; check again only occasionally.
      return Math.max(defaultCooldownMs, 10 * 60_000);
    default:
      return defaultCooldownMs;
  }
}

const SEVERITY_ORDER: readonly FailureKind[] = [
  "context_length",
  "rate_limit",
  "server",
  "timeout",
  "network",
  "protocol",
  "quota",
  "auth",
  "not_found",
  "bad_request",
];

/**
 * Pick the failure that best tells the caller what to do next. Conditions the
 * caller can recover from (compacting, waiting) outrank configuration problems.
 */
export function representativeFailure(
  failures: readonly UpstreamFailure[],
): UpstreamFailure | undefined {
  return [...failures].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.kind) - SEVERITY_ORDER.indexOf(b.kind),
  )[0];
}

export function summarizeFailures(failures: readonly UpstreamFailure[]): string {
  if (failures.length === 0) return "No provider is configured.";
  if (failures.length === 1) return `${failures[0]!.provider}: ${failures[0]!.message}`;
  return failures.map((failure) => `${failure.provider}: ${failure.message}`).join(" | ");
}
