import { randomUUID } from "node:crypto";

import { encodeReasoningTag } from "./tags.js";
import { argumentsToCustomInput, isRecord, normalizeArguments, type ToolNames } from "./tools.js";
import type { TokenUsage } from "./types.js";

export type ResponseEventSink = (event: string, data: Record<string, unknown>) => void;

interface ReasoningState {
  id: string;
  outputIndex: number;
  text: string;
  field: "reasoning_content" | "reasoning" | undefined;
  partOpen: boolean;
}

interface MessageState {
  id: string;
  outputIndex: number;
  text: string;
}

interface ToolCallState {
  itemId: string;
  outputIndex: number | undefined;
  callId: string;
  flatName: string;
  argumentsText: string;
  pendingArguments: string;
}

type ThinkState = "probe" | "inside" | "outside";

const APPENDABLE_DETAIL_KEYS = new Set(["text", "summary", "data", "signature"]);
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function estimateTokens(characters: number): number {
  return Math.ceil(characters / 4);
}

export interface TranslatorOptions {
  providerName: string;
  model: string;
  names: ToolNames;
  emit: ResponseEventSink;
  requestCharacters: number;
}

export interface TranslatorResult {
  usage: TokenUsage;
  outputTypes: string[];
  continues: boolean;
}

export class ChatStreamTranslator {
  readonly #options: TranslatorOptions;
  readonly #responseId = newId("resp");
  readonly #createdAt = Math.floor(Date.now() / 1000);
  readonly #output: Record<string, unknown>[] = [];
  readonly #toolCalls = new Map<number, ToolCallState>();
  readonly #usedCallIds = new Set<string>();
  #sequence = 0;
  #nextOutputIndex = 0;
  #started = false;
  #reasoning: ReasoningState | null = null;
  readonly #details: unknown[] = [];
  #sawReasoningText = false;
  #message: MessageState | null = null;
  #thinkState: ThinkState = "probe";
  #thinkBuffer = "";
  #finishReason: string | undefined;
  #usage: Record<string, unknown> | undefined;
  #model: string;
  #outputCharacters = 0;
  #producedText = false;

  constructor(options: TranslatorOptions) {
    this.#options = options;
    this.#model = options.model;
  }

  get finished(): boolean {
    return this.#finishReason !== undefined;
  }

  get finishReason(): string | undefined {
    return this.#finishReason;
  }

  get hasOutput(): boolean {
    if (this.#producedText) return true;
    if (this.#thinkState !== "inside" && this.#thinkBuffer.trim() !== "") return true;
    for (const call of this.#toolCalls.values()) {
      if (call.flatName !== "") return true;
    }
    return false;
  }

  feed(chunk: unknown): void {
    if (!isRecord(chunk)) return;
    this.#start();
    if (typeof chunk["model"] === "string" && chunk["model"] !== "") this.#model = chunk["model"];
    if (isRecord(chunk["usage"])) this.#usage = chunk["usage"];
    const choices = chunk["choices"];
    if (!Array.isArray(choices)) return;
    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      const index = choice["index"];
      if (typeof index === "number" && index !== 0) continue;
      const delta = isRecord(choice["delta"])
        ? choice["delta"]
        : isRecord(choice["message"])
          ? choice["message"]
          : null;
      if (delta) this.#delta(delta);
      if (typeof choice["finish_reason"] === "string" && choice["finish_reason"] !== "") {
        this.#finishReason = choice["finish_reason"];
      }
    }
  }

  complete(
    keepTurnOpen?: (output: readonly Record<string, unknown>[]) => boolean,
  ): TranslatorResult {
    this.#start();
    this.#flushThinkBuffer();
    this.#closeReasoning();
    this.#closeMessage();
    this.#closeToolCalls();
    this.#emitDetails();
    const usage = this.#tokenUsage();
    const incomplete = this.#finishReason === "content_filter";
    const continues = !incomplete && keepTurnOpen?.(this.#output) === true;
    this.#emit(incomplete ? "response.incomplete" : "response.completed", {
      response: {
        ...this.#envelope(incomplete ? "incomplete" : "completed"),
        output: this.#output,
        ...(continues ? { end_turn: false } : {}),
        usage: {
          input_tokens: usage.inputTokens,
          input_tokens_details: { cached_tokens: usage.cachedInputTokens },
          output_tokens: usage.outputTokens,
          output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
          total_tokens: usage.totalTokens,
        },
        ...(incomplete ? { incomplete_details: { reason: "content_filter" } } : {}),
      },
    });
    return { usage, outputTypes: this.#output.map((item) => String(item["type"])), continues };
  }

  #start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#emit("response.created", { response: { ...this.#envelope("in_progress"), output: [] } });
    this.#emit("response.in_progress", {
      response: { ...this.#envelope("in_progress"), output: [] },
    });
  }

  #envelope(status: string): Record<string, unknown> {
    return {
      id: this.#responseId,
      object: "response",
      created_at: this.#createdAt,
      status,
      model: this.#model,
      error: null,
      incomplete_details: null,
    };
  }

  #emit(event: string, data: Record<string, unknown>): void {
    this.#options.emit(event, { type: event, sequence_number: this.#sequence++, ...data });
  }

  #delta(delta: Record<string, unknown>): void {
    const reasoningContent = delta["reasoning_content"];
    const reasoning = delta["reasoning"];
    if (typeof reasoningContent === "string" && reasoningContent !== "") {
      this.#sawReasoningText = true;
      this.#reasoningDelta(reasoningContent, "reasoning_content");
    } else if (typeof reasoning === "string" && reasoning !== "") {
      this.#sawReasoningText = true;
      this.#reasoningDelta(reasoning, "reasoning");
    }
    if (Array.isArray(delta["reasoning_details"]))
      this.#reasoningDetails(delta["reasoning_details"]);

    const content = delta["content"];
    if (typeof content === "string" && content !== "") this.#contentDelta(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (isRecord(part) && typeof part["text"] === "string" && part["text"] !== "") {
          this.#contentDelta(part["text"]);
        }
      }
    }

    if (Array.isArray(delta["tool_calls"])) {
      delta["tool_calls"].forEach((call, position) => {
        if (isRecord(call)) this.#toolCallDelta(call, position);
      });
    }
  }

  #openReasoning(): ReasoningState {
    if (this.#reasoning) return this.#reasoning;
    this.#closeMessage();
    const state: ReasoningState = {
      id: newId("rs"),
      outputIndex: this.#nextOutputIndex++,
      text: "",
      field: undefined,
      partOpen: false,
    };
    this.#reasoning = state;
    this.#emit("response.output_item.added", {
      output_index: state.outputIndex,
      item: { id: state.id, type: "reasoning", status: "in_progress", summary: [] },
    });
    return state;
  }

  #reasoningDelta(text: string, field: "reasoning_content" | "reasoning" | undefined): void {
    const state = this.#openReasoning();
    if (field !== undefined) state.field ??= field;
    if (!state.partOpen) {
      state.partOpen = true;
      this.#emit("response.reasoning_summary_part.added", {
        item_id: state.id,
        output_index: state.outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
    }
    state.text += text;
    this.#outputCharacters += text.length;
    this.#emit("response.reasoning_summary_text.delta", {
      item_id: state.id,
      output_index: state.outputIndex,
      summary_index: 0,
      delta: text,
    });
  }

  #reasoningDetails(details: unknown[]): void {
    for (const detail of details) {
      if (!isRecord(detail)) continue;
      const index = typeof detail["index"] === "number" ? detail["index"] : this.#details.length;
      const existing = this.#details[index];
      if (isRecord(existing)) {
        for (const [key, value] of Object.entries(detail)) {
          const current = existing[key];
          if (
            typeof value === "string" &&
            typeof current === "string" &&
            APPENDABLE_DETAIL_KEYS.has(key)
          ) {
            existing[key] = current + value;
          } else if (value !== undefined && value !== null) {
            existing[key] = value;
          }
        }
      } else {
        this.#details[index] = { ...detail };
      }
      if (this.#sawReasoningText) continue;
      const visible =
        typeof detail["text"] === "string"
          ? detail["text"]
          : typeof detail["summary"] === "string"
            ? detail["summary"]
            : "";
      if (visible !== "") this.#reasoningDelta(visible, undefined);
    }
  }

  #emitDetails(): void {
    const details = this.#details.filter((detail) => detail !== undefined && detail !== null);
    if (details.length === 0) return;
    const outputIndex = this.#nextOutputIndex++;
    const id = newId("rs");
    this.#emit("response.output_item.added", {
      output_index: outputIndex,
      item: { id, type: "reasoning", status: "in_progress", summary: [] },
    });
    const item = {
      id,
      type: "reasoning",
      status: "completed",
      summary: [],
      encrypted_content: encodeReasoningTag({ provider: this.#options.providerName, details }),
    };
    this.#output.push(item);
    this.#emit("response.output_item.done", { output_index: outputIndex, item });
  }

  #closeReasoning(): void {
    const state = this.#reasoning;
    if (!state) return;
    this.#reasoning = null;
    if (state.partOpen) {
      this.#emit("response.reasoning_summary_text.done", {
        item_id: state.id,
        output_index: state.outputIndex,
        summary_index: 0,
        text: state.text,
      });
      this.#emit("response.reasoning_summary_part.done", {
        item_id: state.id,
        output_index: state.outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: state.text },
      });
    }
    const item = {
      id: state.id,
      type: "reasoning",
      status: "completed",
      summary: state.text === "" ? [] : [{ type: "summary_text", text: state.text }],
      encrypted_content: encodeReasoningTag({
        provider: this.#options.providerName,
        ...(state.field === undefined ? {} : { field: state.field }),
      }),
    };
    this.#output.push(item);
    this.#emit("response.output_item.done", { output_index: state.outputIndex, item });
  }

  #contentDelta(text: string): void {
    if (this.#thinkState === "outside") {
      this.#textDelta(text);
      return;
    }
    this.#thinkBuffer += text;
    if (this.#thinkState === "probe") {
      const trimmed = this.#thinkBuffer.trimStart();
      if (trimmed.startsWith(THINK_OPEN)) {
        this.#thinkState = "inside";
        this.#thinkBuffer = trimmed.slice(THINK_OPEN.length);
      } else if (trimmed.length < THINK_OPEN.length && THINK_OPEN.startsWith(trimmed)) {
        return;
      } else {
        this.#thinkState = "outside";
        const buffered = this.#thinkBuffer;
        this.#thinkBuffer = "";
        this.#textDelta(buffered);
        return;
      }
    }
    const close = this.#thinkBuffer.indexOf(THINK_CLOSE);
    if (close >= 0) {
      const inside = this.#thinkBuffer.slice(0, close);
      const after = this.#thinkBuffer.slice(close + THINK_CLOSE.length).replace(/^\s+/u, "");
      this.#thinkBuffer = "";
      this.#thinkState = "outside";
      if (inside !== "") this.#reasoningDelta(inside, undefined);
      if (after !== "") this.#textDelta(after);
      return;
    }
    let keep = 0;
    for (
      let length = Math.min(THINK_CLOSE.length - 1, this.#thinkBuffer.length);
      length > 0;
      length--
    ) {
      if (THINK_CLOSE.startsWith(this.#thinkBuffer.slice(-length))) {
        keep = length;
        break;
      }
    }
    const ready = this.#thinkBuffer.slice(0, this.#thinkBuffer.length - keep);
    this.#thinkBuffer = this.#thinkBuffer.slice(this.#thinkBuffer.length - keep);
    if (ready !== "") this.#reasoningDelta(ready, undefined);
  }

  #flushThinkBuffer(): void {
    if (this.#thinkBuffer === "") return;
    const buffered = this.#thinkBuffer;
    this.#thinkBuffer = "";
    if (this.#thinkState === "inside") this.#reasoningDelta(buffered, undefined);
    else this.#textDelta(buffered);
    this.#thinkState = "outside";
  }

  #textDelta(text: string): void {
    if (text === "") return;
    let state = this.#message;
    if (!state) {
      if (text.trim() === "" && !this.#producedText) return;
      this.#closeReasoning();
      state = { id: newId("msg"), outputIndex: this.#nextOutputIndex++, text: "" };
      this.#message = state;
      this.#emit("response.output_item.added", {
        output_index: state.outputIndex,
        item: {
          id: state.id,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      });
      this.#emit("response.content_part.added", {
        item_id: state.id,
        output_index: state.outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    this.#producedText = true;
    state.text += text;
    this.#outputCharacters += text.length;
    this.#emit("response.output_text.delta", {
      item_id: state.id,
      output_index: state.outputIndex,
      content_index: 0,
      delta: text,
    });
  }

  #closeMessage(): void {
    const state = this.#message;
    if (!state) return;
    this.#message = null;
    const part = { type: "output_text", text: state.text, annotations: [] };
    this.#emit("response.output_text.done", {
      item_id: state.id,
      output_index: state.outputIndex,
      content_index: 0,
      text: state.text,
    });
    this.#emit("response.content_part.done", {
      item_id: state.id,
      output_index: state.outputIndex,
      content_index: 0,
      part,
    });
    const item = {
      id: state.id,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [part],
    };
    this.#output.push(item);
    this.#emit("response.output_item.done", { output_index: state.outputIndex, item });
  }

  #toolCallDelta(call: Record<string, unknown>, position: number): void {
    const index = typeof call["index"] === "number" ? call["index"] : position;
    const fn = isRecord(call["function"]) ? call["function"] : {};
    let state = this.#toolCalls.get(index);
    if (!state) {
      state = {
        itemId: newId("fc"),
        outputIndex: undefined,
        callId: this.#callId(call["id"]),
        flatName: "",
        argumentsText: "",
        pendingArguments: "",
      };
      this.#toolCalls.set(index, state);
    }
    if (typeof fn["name"] === "string" && fn["name"] !== "" && state.flatName === "") {
      state.flatName = fn["name"];
    }
    const fragment =
      typeof fn["arguments"] === "string"
        ? fn["arguments"]
        : isRecord(fn["arguments"])
          ? JSON.stringify(fn["arguments"])
          : "";
    if (state.outputIndex === undefined) {
      state.pendingArguments += fragment;
      if (state.flatName === "") return;
      this.#flushThinkBuffer();
      this.#closeReasoning();
      this.#closeMessage();
      state.outputIndex = this.#nextOutputIndex++;
      this.#emit("response.output_item.added", {
        output_index: state.outputIndex,
        item: this.#toolItem(state, "in_progress", ""),
      });
      const pending = state.pendingArguments;
      state.pendingArguments = "";
      this.#argumentsDelta(state, pending);
      return;
    }
    this.#argumentsDelta(state, fragment);
  }

  #argumentsDelta(state: ToolCallState, fragment: string): void {
    if (fragment === "" || state.outputIndex === undefined) return;
    state.argumentsText += fragment;
    this.#outputCharacters += fragment.length;
    if (this.#options.names.resolve(state.flatName).kind === "custom") return;
    this.#emit("response.function_call_arguments.delta", {
      item_id: state.itemId,
      output_index: state.outputIndex,
      delta: fragment,
    });
  }

  #callId(value: unknown): string {
    let id =
      typeof value === "string" && value.length >= 8
        ? value
        : `call_${randomUUID().replaceAll("-", "")}`;
    if (this.#usedCallIds.has(id)) id = `call_${randomUUID().replaceAll("-", "")}`;
    this.#usedCallIds.add(id);
    return id;
  }

  #toolItem(state: ToolCallState, status: string, argumentsText: string): Record<string, unknown> {
    const identity = this.#options.names.resolve(state.flatName);
    const namespace = identity.namespace === undefined ? {} : { namespace: identity.namespace };
    if (identity.kind === "custom") {
      return {
        id: state.itemId,
        type: "custom_tool_call",
        status,
        call_id: state.callId,
        name: identity.name,
        ...namespace,
        input: status === "completed" ? argumentsToCustomInput(argumentsText) : "",
      };
    }
    return {
      id: state.itemId,
      type: "function_call",
      status,
      name: identity.name,
      ...namespace,
      call_id: state.callId,
      arguments: status === "completed" ? normalizeArguments(argumentsText) : argumentsText,
    };
  }

  #closeToolCalls(): void {
    const ordered = [...this.#toolCalls.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, state] of ordered) {
      if (state.flatName === "") continue;
      if (state.outputIndex === undefined) {
        state.outputIndex = this.#nextOutputIndex++;
        this.#emit("response.output_item.added", {
          output_index: state.outputIndex,
          item: this.#toolItem(state, "in_progress", ""),
        });
        state.argumentsText = state.pendingArguments;
      }
      const argumentsText = state.argumentsText.trim() === "" ? "{}" : state.argumentsText;
      const item = this.#toolItem(state, "completed", argumentsText);
      if (item["type"] === "function_call") {
        this.#emit("response.function_call_arguments.done", {
          item_id: state.itemId,
          output_index: state.outputIndex,
          arguments: item["arguments"],
        });
      }
      this.#output.push(item);
      this.#emit("response.output_item.done", { output_index: state.outputIndex, item });
    }
    this.#toolCalls.clear();
  }

  #tokenUsage(): TokenUsage {
    const usage = this.#usage;
    const number = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.round(value)
        : undefined;
    const prompt = number(usage?.["prompt_tokens"]) ?? number(usage?.["input_tokens"]);
    const completion = number(usage?.["completion_tokens"]) ?? number(usage?.["output_tokens"]);
    const promptDetails = isRecord(usage?.["prompt_tokens_details"])
      ? usage["prompt_tokens_details"]
      : undefined;
    const completionDetails = isRecord(usage?.["completion_tokens_details"])
      ? usage["completion_tokens_details"]
      : undefined;
    const estimated = prompt === undefined || completion === undefined;
    const inputTokens = prompt ?? estimateTokens(this.#options.requestCharacters);
    const outputTokens = completion ?? estimateTokens(this.#outputCharacters);
    const cached =
      number(promptDetails?.["cached_tokens"]) ??
      number(usage?.["prompt_cache_hit_tokens"]) ??
      number(usage?.["cached_tokens"]) ??
      0;
    return {
      inputTokens,
      cachedInputTokens: Math.min(cached, inputTokens),
      outputTokens,
      reasoningTokens: Math.min(number(completionDetails?.["reasoning_tokens"]) ?? 0, outputTokens),
      totalTokens: number(usage?.["total_tokens"]) ?? inputTokens + outputTokens,
      estimated,
    };
  }
}
