/**
 * Reasoning items travel through Codex as opaque `encrypted_content`. The gateway
 * wraps that field with the provider that produced it, so a later request can
 * return each item only to the endpoint able to read it. This is what lets a
 * conversation move between providers mid-scan.
 */

const PREFIX = "kscan1";

export interface ReasoningTag {
  /** Provider that produced the reasoning. */
  provider: string;
  /** Original opaque value from a Responses endpoint. */
  encrypted?: string;
  /** Chat endpoints: the delta field the text arrived in. */
  field?: "reasoning_content" | "reasoning";
  /** Chat endpoints: reasoning text to replay on the next request. */
  text?: string;
  /** Chat endpoints: OpenRouter-style reasoning_details to replay. */
  details?: unknown[];
}

interface Header {
  p: string;
  f?: "reasoning_content" | "reasoning";
  t?: string;
  d?: unknown[];
}

export function encodeReasoningTag(tag: ReasoningTag): string {
  const header: Header = { p: tag.provider };
  if (tag.field !== undefined) header.f = tag.field;
  if (tag.text !== undefined) header.t = tag.text;
  if (tag.details !== undefined) header.d = tag.details;
  const encoded = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  // The original value is appended verbatim to avoid re-encoding large blobs.
  return `${PREFIX}:${encoded}:${tag.encrypted ?? ""}`;
}

export function decodeReasoningTag(value: unknown): ReasoningTag | null {
  if (typeof value !== "string" || !value.startsWith(`${PREFIX}:`)) return null;
  const rest = value.slice(PREFIX.length + 1);
  const separator = rest.indexOf(":");
  if (separator < 0) return null;
  try {
    const header = JSON.parse(
      Buffer.from(rest.slice(0, separator), "base64url").toString("utf8"),
    ) as Header;
    if (typeof header.p !== "string") return null;
    const tag: ReasoningTag = { provider: header.p };
    const encrypted = rest.slice(separator + 1);
    if (encrypted !== "") tag.encrypted = encrypted;
    if (header.f === "reasoning_content" || header.f === "reasoning") tag.field = header.f;
    if (typeof header.t === "string") tag.text = header.t;
    if (Array.isArray(header.d)) tag.details = header.d;
    return tag;
  } catch {
    return null;
  }
}
