import { isRecord } from "./tools.js";

const MARKER_LINE = /^CODEX_SECURITY_[A-Z_]+ \{.*\}$/u;

const TOOL_CALL_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "tool_search_call",
]);

export function isInterimOutput(items: readonly unknown[]): boolean {
  let text = "";
  let messages = 0;
  let commentaryOnly = true;
  for (const item of items) {
    if (!isRecord(item)) continue;
    const type = item["type"];
    if (typeof type === "string" && TOOL_CALL_TYPES.has(type)) return false;
    if (type !== "message" || item["role"] !== "assistant") continue;
    messages += 1;
    if (item["phase"] !== "commentary") commentaryOnly = false;
    const content = item["content"];
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (isRecord(part) && typeof part["text"] === "string") text += `${part["text"]}\n`;
    }
  }
  if (messages === 0) return items.some((item) => isRecord(item) && item["type"] === "reasoning");
  if (commentaryOnly) return true;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length > 0 && lines.every((line) => MARKER_LINE.test(line));
}

export class TurnGuard {
  readonly #limit: number;
  readonly #consecutive = new Map<string, number>();

  constructor(limit = 3) {
    this.#limit = limit;
  }

  shouldContinue(conversation: string, items: readonly unknown[]): boolean {
    if (!isInterimOutput(items)) {
      this.#consecutive.delete(conversation);
      return false;
    }
    const count = (this.#consecutive.get(conversation) ?? 0) + 1;
    if (count > this.#limit) return false;
    this.#consecutive.set(conversation, count);
    if (this.#consecutive.size > 1024) {
      const oldest = this.#consecutive.keys().next().value;
      if (oldest !== undefined) this.#consecutive.delete(oldest);
    }
    return true;
  }
}
