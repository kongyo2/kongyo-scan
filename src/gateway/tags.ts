const PREFIX = "kscan1";

export interface ReasoningTag {
  provider: string;
  encrypted?: string;
  field?: "reasoning_content" | "reasoning";
  text?: string;
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
