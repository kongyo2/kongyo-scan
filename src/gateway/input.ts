import { isRecord } from "./tools.js";

/**
 * Codex's multi-agent conversations carry `agent_message` items: a note from one
 * agent to another. Only OpenAI's own backend accepts that item type, so every
 * other endpoint gets the same words as an ordinary message.
 *
 * A task handed to a sub-agent arrives as a plain header followed by an
 * `encrypted_content` part. OpenAI encrypts that part; any other model wrote it
 * in the clear, so here it is readable text and is kept.
 */
export function agentMessageText(item: Record<string, unknown>): string {
  const content = item["content"];
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (!isRecord(part)) continue;
    const piece =
      typeof part["text"] === "string"
        ? part["text"]
        : typeof part["encrypted_content"] === "string"
          ? part["encrypted_content"]
          : "";
    if (piece === "") continue;
    // Parts are separate lines unless the previous one already ended its line.
    if (text !== "" && !/\s$/u.test(text)) text += "\n";
    text += piece;
  }
  return text.trim() === "" ? "" : text;
}

/** An `agent_message` as a Responses message item, or null when it carries no text. */
export function agentMessageAsInput(item: Record<string, unknown>): Record<string, unknown> | null {
  const text = agentMessageText(item);
  if (text === "") return null;
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

/** Input item types every Responses-compatible endpoint is expected to accept. */
const PORTABLE_ITEM_TYPES = new Set([
  "message",
  "reasoning",
  "function_call",
  "function_call_output",
]);

/** True for items that only OpenAI's backend understands, such as hosted-tool records and compaction. */
export function isOpenAiOnlyItem(item: Record<string, unknown>): boolean {
  const type = item["type"];
  return typeof type === "string" && !PORTABLE_ITEM_TYPES.has(type);
}
