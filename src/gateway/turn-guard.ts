import { isRecord } from "./tools.js";

/**
 * Codex Security asks the scan agent to print standalone progress lines such as
 * `CODEX_SECURITY_SCAN_PROGRESS {"phase":"discovery",…}`. OpenAI models send
 * these as commentary and keep working. Other models often send one as their
 * whole answer, and a response without a tool call ends the turn, which stops
 * the scan before it has produced anything.
 */
const MARKER_LINE = /^CODEX_SECURITY_[A-Z_]+ \{.*\}$/u;

const TOOL_CALL_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "tool_search_call",
]);

/** True when a response is only interim output: no tool call, and nothing but progress markers or commentary. */
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
  // Reasoning with no answer at all would also end the turn with nothing done.
  if (messages === 0) return items.some((item) => isRecord(item) && item["type"] === "reasoning");
  if (commentaryOnly) return true;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length > 0 && lines.every((line) => MARKER_LINE.test(line));
}

/**
 * Decides whether a finished response should keep its turn open. Each
 * conversation gets a small budget of consecutive continuations, so a model that
 * only ever prints markers cannot loop forever.
 */
export class TurnGuard {
  readonly #limit: number;
  readonly #consecutive = new Map<string, number>();

  constructor(limit = 3) {
    this.#limit = limit;
  }

  /** Returns true when the response should be marked as not ending the turn. */
  shouldContinue(conversation: string, items: readonly unknown[]): boolean {
    if (!isInterimOutput(items)) {
      this.#consecutive.delete(conversation);
      return false;
    }
    const count = (this.#consecutive.get(conversation) ?? 0) + 1;
    if (count > this.#limit) return false;
    this.#consecutive.set(conversation, count);
    // Bound memory across very long sessions with many sub-agent threads.
    if (this.#consecutive.size > 1024) {
      const oldest = this.#consecutive.keys().next().value;
      if (oldest !== undefined) this.#consecutive.delete(oldest);
    }
    return true;
  }
}
