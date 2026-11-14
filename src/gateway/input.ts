import { isRecord } from "./tools.js";

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
    if (text !== "" && !/\s$/u.test(text)) text += "\n";
    text += piece;
  }
  return text.trim() === "" ? "" : text;
}

export function agentMessageAsInput(item: Record<string, unknown>): Record<string, unknown> | null {
  const text = agentMessageText(item);
  if (text === "") return null;
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

const PORTABLE_ITEM_TYPES = new Set([
  "message",
  "reasoning",
  "function_call",
  "function_call_output",
]);

export function isOpenAiOnlyItem(item: Record<string, unknown>): boolean {
  const type = item["type"];
  return typeof type === "string" && !PORTABLE_ITEM_TYPES.has(type);
}
