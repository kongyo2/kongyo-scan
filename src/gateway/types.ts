import type { JsonObject, WireApi } from "../config/schema.js";

/** USD per 1M tokens. */
export interface Pricing {
  inputPerMtok: number;
  cachedInputPerMtok: number;
  outputPerMtok: number;
}

/** A provider with its credential and defaults resolved, ready to receive requests. */
export interface ResolvedProvider {
  name: string;
  /** Base URL without a trailing slash. */
  baseUrl: string;
  model: string;
  wireApi: WireApi;
  /** Undefined for endpoints that take no credential. */
  apiKey: string | undefined;
  /** Where the key came from, for diagnostics. Never the key itself. */
  apiKeySource: string | undefined;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
  /** Effort override; "default" removes the parameter. */
  reasoningEffort: string | undefined;
  contextWindow: number | undefined;
  maxOutputTokens: number | undefined;
  firstByteTimeoutMs: number;
  pricing: Pricing | undefined;
  compat: {
    /**
     * The endpoint is OpenAI's own Responses API, so requests keep Codex's native
     * shape. Every other endpoint gets the portable shape: plain function tools
     * and plain messages. Chat endpoints are always portable.
     */
    nativeResponses: boolean;
    images: boolean;
    omitParams: readonly string[];
    extraBody: JsonObject;
  };
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** True when the endpoint reported no usage and the numbers are a size-based estimate. */
  estimated: boolean;
}

export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    estimated: false,
  };
}

export type FailureKind =
  | "auth"
  | "quota"
  | "rate_limit"
  | "context_length"
  | "not_found"
  | "bad_request"
  | "server"
  | "network"
  | "timeout"
  | "protocol";

/** Why one provider could not serve a request. Carries no secrets. */
export interface UpstreamFailure {
  provider: string;
  kind: FailureKind;
  /** HTTP status when the endpoint answered. */
  status: number | undefined;
  /** Provider error code when present, such as rate_limit_exceeded. */
  code: string | undefined;
  /** Sanitized, single-line description. */
  message: string;
  retryAfterMs: number | undefined;
}

export class UpstreamError extends Error {
  readonly failure: UpstreamFailure;

  constructor(failure: UpstreamFailure, cause?: unknown) {
    super(failure.message, cause === undefined ? undefined : { cause });
    this.name = "UpstreamError";
    this.failure = failure;
  }
}

/** What the gateway reports while it works, for progress displays and debug logs. */
export type GatewayEvent =
  | { type: "request"; id: number; sessionId: string | undefined; at: number }
  | { type: "attempt"; id: number; provider: string; model: string; wireApi: WireApi }
  | { type: "failure"; id: number; failure: UpstreamFailure; committed: boolean }
  | { type: "fallback"; id: number; from: string; to: string; failure: UpstreamFailure }
  | {
      type: "completed";
      id: number;
      provider: string;
      model: string;
      usage: TokenUsage;
      durationMs: number;
      /** Types of the output items, in order. */
      outputTypes: string[];
      /** The gateway kept the turn open because the answer was interim output only. */
      continued: boolean;
    }
  | { type: "exhausted"; id: number; failures: UpstreamFailure[] }
  | { type: "aborted"; id: number };

export type GatewayObserver = (event: GatewayEvent) => void;
