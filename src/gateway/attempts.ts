import {
  applyCompat,
  cleanSchema,
  resolveEffort,
  type ResponsesRequest,
  toChatRequest,
} from "./chat-request.js";
import { ChatStreamTranslator, estimateTokens } from "./chat-stream.js";
import { classifyStreamError, protocolFailure } from "./failure.js";
import { agentMessageAsInput, isOpenAiOnlyItem } from "./input.js";
import { readSse } from "./sse.js";
import { decodeReasoningTag, encodeReasoningTag } from "./tags.js";
import {
  argumentsToCustomInput,
  customInputToArguments,
  flattenTools,
  isRecord,
  type ToolNames,
} from "./tools.js";
import type { TurnGuard } from "./turn-guard.js";
import { emptyUsage, type ResolvedProvider, type TokenUsage, UpstreamError } from "./types.js";
import { postUpstream, type RequestMeta, readText } from "./upstream.js";

/** Where an attempt writes the Responses events it produces. */
export interface AttemptSink {
  /** True once output from this attempt has reached the client. */
  readonly committed: boolean;
  write(event: string, data: Record<string, unknown>): void;
}

export interface AttemptContext {
  provider: ResolvedProvider;
  request: ResponsesRequest;
  /** Size of the serialized request, for usage estimates. */
  requestCharacters: number;
  meta: RequestMeta;
  relay: AttemptSink;
  signal: AbortSignal;
  idleTimeoutMs: number;
  /** Keeps a turn open when the model answered with interim output only. Absent for probes. */
  guard?: TurnGuard | undefined;
}

export interface AttemptResult {
  usage: TokenUsage;
  model: string;
  /** Types of the output items, in order, for diagnostics. */
  outputTypes: string[];
  /** The response was marked as not ending the turn. */
  continued: boolean;
}

function conversationOf(context: AttemptContext): string {
  return context.meta.threadId ?? context.meta.sessionId;
}

/** Send one request to one provider and relay its answer. Throws `UpstreamError` on failure. */
export async function runAttempt(context: AttemptContext): Promise<AttemptResult> {
  return context.provider.wireApi === "chat"
    ? await runChatAttempt(context)
    : await runResponsesAttempt(context);
}

async function runChatAttempt(context: AttemptContext): Promise<AttemptResult> {
  const { provider, relay } = context;
  const { body, names } = toChatRequest(context.request, provider);
  const upstream = await postUpstream(
    provider,
    "/chat/completions",
    body,
    context.meta,
    context.signal,
  );
  const translator = new ChatStreamTranslator({
    providerName: provider.name,
    model: provider.model,
    names,
    emit: (event, data) => relay.write(event, data),
    requestCharacters: context.requestCharacters,
  });

  try {
    const contentType = upstream.response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      // The endpoint ignored `stream: true` and answered in one piece.
      const text = await readText(upstream.response, 64 * 1024 * 1024);
      const parsed = parseJson(text);
      if (isRecord(parsed) && parsed["error"] !== undefined && parsed["error"] !== null) {
        throw new UpstreamError(classifyStreamError(provider.name, parsed["error"]));
      }
      if (!isRecord(parsed) || !Array.isArray(parsed["choices"])) {
        throw new UpstreamError(
          protocolFailure(provider.name, "The endpoint returned an unexpected body."),
        );
      }
      translator.feed(parsed);
    } else {
      let sawDone = false;
      for await (const message of readSse(upstream.body(context.idleTimeoutMs))) {
        const data = message.data.trim();
        if (data === "") continue;
        if (data === "[DONE]") {
          sawDone = true;
          break;
        }
        const chunk = parseJson(data);
        if (!isRecord(chunk)) continue;
        if (chunk["error"] !== undefined && chunk["error"] !== null) {
          throw new UpstreamError(classifyStreamError(provider.name, chunk["error"]));
        }
        translator.feed(chunk);
      }
      if (!sawDone && !translator.finished) {
        throw new UpstreamError(
          protocolFailure(provider.name, "The stream ended before the response finished."),
        );
      }
    }
  } finally {
    upstream.abort();
  }

  if (translator.finishReason === "error") {
    throw new UpstreamError(
      protocolFailure(provider.name, "The endpoint stopped the response with an error."),
    );
  }
  // An answer with neither text nor a tool call would end the turn silently; treat it as a failure.
  if (!translator.hasOutput && translator.finishReason !== "content_filter") {
    throw new UpstreamError(
      protocolFailure(provider.name, "The model returned an empty response."),
    );
  }
  const guard = context.guard;
  const result = translator.complete(
    guard ? (output) => guard.shouldContinue(conversationOf(context), output) : undefined,
  );
  return {
    usage: result.usage,
    model: provider.model,
    outputTypes: result.outputTypes,
    continued: result.continues,
  };
}

async function runResponsesAttempt(context: AttemptContext): Promise<AttemptResult> {
  const { provider, relay } = context;
  const { body, names, aliases } = prepareResponsesBody(context.request, provider);
  const upstream = await postUpstream(provider, "/responses", body, context.meta, context.signal);
  let usage: TokenUsage | undefined;
  let terminal = false;
  let outputCharacters = 0;
  let continued = false;
  const finished: Record<string, unknown>[] = [];

  const handle = (event: Record<string, unknown>): void => {
    const type = typeof event["type"] === "string" ? event["type"] : "";
    if (type === "") return;
    if (type === "response.failed" || type === "error") {
      const error =
        type === "error"
          ? (event["error"] ?? event)
          : isRecord(event["response"])
            ? event["response"]["error"]
            : undefined;
      // Before any output was relayed, a failed response is a reason to try the next provider.
      if (!relay.committed) throw new UpstreamError(classifyStreamError(provider.name, error));
      terminal = true;
      relay.write(type, event);
      return;
    }
    if (isRecord(event["item"]))
      event["item"] = restoreItem(event["item"], provider, names, aliases);
    if (isRecord(event["response"]) && Array.isArray(event["response"]["output"])) {
      event["response"]["output"] = event["response"]["output"].map((item) =>
        isRecord(item) ? restoreItem(item, provider, names, aliases) : item,
      );
    }
    if (typeof event["delta"] === "string") outputCharacters += event["delta"].length;
    if (type === "response.output_item.done" && isRecord(event["item"]))
      finished.push(event["item"]);
    if (type === "response.completed" || type === "response.incomplete") {
      const response = isRecord(event["response"]) ? event["response"] : {};
      const listed = Array.isArray(response["output"]) ? response["output"].length : 0;
      // An answer with no output at all would end the turn silently; treat it as a failure.
      if (
        type === "response.completed" &&
        !relay.committed &&
        finished.length === 0 &&
        listed === 0
      ) {
        throw new UpstreamError(
          protocolFailure(provider.name, "The model returned an empty response."),
        );
      }
      terminal = true;
      if (type === "response.completed" && response["end_turn"] === undefined && context.guard) {
        const output =
          finished.length > 0
            ? finished
            : Array.isArray(response["output"])
              ? response["output"]
              : [];
        if (context.guard.shouldContinue(conversationOf(context), output)) {
          response["end_turn"] = false;
          event["response"] = response;
          continued = true;
        }
      }
      usage = readResponsesUsage(response["usage"]);
      if (usage === undefined) {
        usage = estimatedUsage(context.requestCharacters, outputCharacters);
        response["usage"] = toResponsesUsage(usage);
        event["response"] = response;
      }
    }
    relay.write(type, event);
  };

  try {
    const contentType = upstream.response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const parsed = parseJson(await readText(upstream.response, 64 * 1024 * 1024));
      if (!isRecord(parsed)) {
        throw new UpstreamError(
          protocolFailure(provider.name, "The endpoint returned an unexpected body."),
        );
      }
      if (
        parsed["error"] !== undefined &&
        parsed["error"] !== null &&
        parsed["status"] !== "completed"
      ) {
        throw new UpstreamError(classifyStreamError(provider.name, parsed["error"]));
      }
      for (const event of synthesizeEvents(parsed)) handle(event);
    } else {
      for await (const message of readSse(upstream.body(context.idleTimeoutMs))) {
        const data = message.data.trim();
        if (data === "" || data === "[DONE]") continue;
        const event = parseJson(data);
        if (!isRecord(event)) continue;
        if (typeof event["type"] !== "string" && message.event !== undefined)
          event["type"] = message.event;
        handle(event);
        if (terminal) break;
      }
    }
  } finally {
    upstream.abort();
  }

  if (!terminal) {
    throw new UpstreamError(
      protocolFailure(provider.name, "The stream ended before the response finished."),
    );
  }
  return {
    usage: usage ?? emptyUsage(),
    model: provider.model,
    outputTypes: finished.map((item) => String(item["type"])),
    continued,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function estimatedUsage(requestCharacters: number, outputCharacters: number): TokenUsage {
  const inputTokens = estimateTokens(requestCharacters);
  const outputTokens = estimateTokens(outputCharacters);
  return {
    inputTokens,
    cachedInputTokens: 0,
    outputTokens,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  };
}

function toResponsesUsage(usage: TokenUsage): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    input_tokens_details: { cached_tokens: usage.cachedInputTokens },
    output_tokens: usage.outputTokens,
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
    total_tokens: usage.totalTokens,
  };
}

export function readResponsesUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const number = (candidate: unknown): number | undefined =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
      ? Math.round(candidate)
      : undefined;
  const inputTokens = number(value["input_tokens"]);
  const outputTokens = number(value["output_tokens"]);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const inputDetails = isRecord(value["input_tokens_details"]) ? value["input_tokens_details"] : {};
  const outputDetails = isRecord(value["output_tokens_details"])
    ? value["output_tokens_details"]
    : {};
  return {
    inputTokens,
    cachedInputTokens: Math.min(number(inputDetails["cached_tokens"]) ?? 0, inputTokens),
    outputTokens,
    reasoningTokens: Math.min(number(outputDetails["reasoning_tokens"]) ?? 0, outputTokens),
    totalTokens: number(value["total_tokens"]) ?? inputTokens + outputTokens,
    estimated: false,
  };
}

/** Spellings some endpoints use for a namespaced tool, mapped back to its real identity. */
export type NamespaceAliases = ReadonlyMap<string, { name: string; namespace: string }>;

/**
 * Index the ways an endpoint may spell a namespaced tool in its answer. Some
 * return `namespace.tool` as the call name instead of separate fields.
 */
export function namespaceAliases(tools: unknown): NamespaceAliases {
  const aliases = new Map<string, { name: string; namespace: string }>();
  if (!Array.isArray(tools)) return aliases;
  const topLevel = new Set<string>();
  for (const tool of tools) {
    if (isRecord(tool) && tool["type"] !== "namespace" && typeof tool["name"] === "string")
      topLevel.add(tool["name"]);
  }
  for (const tool of tools) {
    if (!isRecord(tool) || tool["type"] !== "namespace" || typeof tool["name"] !== "string")
      continue;
    const namespace = tool["name"];
    for (const member of Array.isArray(tool["tools"]) ? tool["tools"] : []) {
      if (!isRecord(member) || typeof member["name"] !== "string") continue;
      const identity = { name: member["name"], namespace };
      for (const separator of [".", "__", "/", ":"]) {
        const alias = `${namespace}${separator}${member["name"]}`;
        if (!topLevel.has(alias)) aliases.set(alias, identity);
      }
    }
  }
  return aliases;
}

/** Build the request for a Responses endpoint from what Codex sent. */
export function prepareResponsesBody(
  request: ResponsesRequest,
  provider: ResolvedProvider,
): { body: Record<string, unknown>; names: ToolNames | null; aliases: NamespaceAliases } {
  const body: Record<string, unknown> = { ...request, model: provider.model };

  const effort = resolveEffort(request, provider);
  if (isRecord(request.reasoning) || effort !== undefined) {
    const reasoning = isRecord(request.reasoning) ? { ...request.reasoning } : {};
    if (effort === undefined) delete reasoning["effort"];
    else reasoning["effort"] = effort;
    if (Object.keys(reasoning).length > 0) body["reasoning"] = reasoning;
    else delete body["reasoning"];
  }

  let names: ToolNames | null = null;
  if (!provider.compat.nativeResponses) {
    const flattened = flattenTools(request.tools);
    names = flattened.names;
    if (flattened.functions.length > 0) {
      body["tools"] = flattened.functions.map((tool) => ({
        type: "function",
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: cleanSchema(tool.parameters),
        strict: false,
      }));
    } else {
      delete body["tools"];
      delete body["tool_choice"];
      delete body["parallel_tool_calls"];
    }
    const choice = request.tool_choice;
    if (isRecord(choice) && typeof choice["name"] === "string") {
      const namespace = typeof choice["namespace"] === "string" ? choice["namespace"] : undefined;
      body["tool_choice"] = { type: "function", name: names.flatten(choice["name"], namespace) };
    }
  }

  if (Array.isArray(request.input)) {
    const input: unknown[] = [];
    for (const item of request.input) {
      if (!isRecord(item)) {
        input.push(item);
        continue;
      }
      const prepared = prepareInputItem(item, provider, names);
      if (prepared !== null) input.push(prepared);
    }
    body["input"] = input;
  }

  if (provider.maxOutputTokens !== undefined && body["max_output_tokens"] === undefined) {
    body["max_output_tokens"] = provider.maxOutputTokens;
  }
  applyCompat(body, provider);
  return { body, names, aliases: names === null ? namespaceAliases(request.tools) : new Map() };
}

function prepareInputItem(
  item: Record<string, unknown>,
  provider: ResolvedProvider,
  names: ToolNames | null,
): Record<string, unknown> | null {
  const type = item["type"];
  if (type === "reasoning") {
    const tag = decodeReasoningTag(item["encrypted_content"]);
    if (tag === null) return item;
    // Reasoning is opaque to every endpoint but the one that produced it.
    if (tag.provider !== provider.name) return null;
    const restored: Record<string, unknown> = { ...item };
    if (tag.encrypted !== undefined) restored["encrypted_content"] = tag.encrypted;
    else delete restored["encrypted_content"];
    return restored;
  }
  if (!provider.compat.images && Array.isArray(item["content"])) {
    return {
      ...item,
      content: item["content"].map((part) =>
        isRecord(part) && part["type"] === "input_image"
          ? { type: "input_text", text: "[image omitted: this model accepts text only]" }
          : part,
      ),
    };
  }
  if (names === null) return item;
  // From here on the endpoint is not OpenAI's: only portable items may be sent.
  if (type === "agent_message") return agentMessageAsInput(item);
  if (type === "function_call" && typeof item["name"] === "string") {
    const { namespace, ...rest } = item;
    return {
      ...rest,
      name: names.flatten(item["name"], typeof namespace === "string" ? namespace : undefined),
    };
  }
  if (type === "custom_tool_call" && typeof item["name"] === "string") {
    const { namespace, input, ...rest } = item;
    return {
      ...rest,
      type: "function_call",
      name: names.flatten(item["name"], typeof namespace === "string" ? namespace : undefined),
      arguments: customInputToArguments(typeof input === "string" ? input : ""),
    };
  }
  if (type === "custom_tool_call_output") return { ...item, type: "function_call_output" };
  // Hosted-tool records, compaction, and other OpenAI-only items would be rejected.
  return isOpenAiOnlyItem(item) ? null : item;
}

/** Undo the request-side rewrites on an output item, and tag reasoning with its provider. */
function restoreItem(
  item: Record<string, unknown>,
  provider: ResolvedProvider,
  names: ToolNames | null,
  aliases: NamespaceAliases,
): Record<string, unknown> {
  if (item["type"] === "reasoning") {
    // Items still streaming have no final content yet; tag only completed ones.
    if (item["status"] === "in_progress") return item;
    const original =
      typeof item["encrypted_content"] === "string" ? item["encrypted_content"] : undefined;
    if (original !== undefined && decodeReasoningTag(original) !== null) return item;
    return {
      ...item,
      encrypted_content: encodeReasoningTag({
        provider: provider.name,
        ...(original === undefined ? {} : { encrypted: original }),
      }),
    };
  }
  if (
    names === null &&
    (item["type"] === "function_call" || item["type"] === "custom_tool_call") &&
    typeof item["name"] === "string" &&
    typeof item["namespace"] !== "string"
  ) {
    const identity = aliases.get(item["name"]);
    return identity ? { ...item, name: identity.name, namespace: identity.namespace } : item;
  }
  if (names !== null && item["type"] === "function_call" && typeof item["name"] === "string") {
    const identity = names.resolve(item["name"]);
    if (identity.kind === "custom") {
      const { arguments: argumentsText, name: _name, ...rest } = item;
      return {
        ...rest,
        type: "custom_tool_call",
        name: identity.name,
        ...(identity.namespace === undefined ? {} : { namespace: identity.namespace }),
        input: argumentsToCustomInput(typeof argumentsText === "string" ? argumentsText : ""),
      };
    }
    return {
      ...item,
      name: identity.name,
      ...(identity.namespace === undefined ? {} : { namespace: identity.namespace }),
    };
  }
  return item;
}

/** Replay a non-streaming Responses answer as the events a stream would have carried. */
function synthesizeEvents(response: Record<string, unknown>): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const output = Array.isArray(response["output"]) ? response["output"] : [];
  events.push({
    type: "response.created",
    response: { ...response, status: "in_progress", output: [] },
  });
  output.forEach((item, index) => {
    if (!isRecord(item)) return;
    events.push({ type: "response.output_item.added", output_index: index, item });
    events.push({ type: "response.output_item.done", output_index: index, item });
  });
  const status = response["status"];
  events.push({
    type:
      status === "incomplete"
        ? "response.incomplete"
        : status === "failed"
          ? "response.failed"
          : "response.completed",
    response,
  });
  return events;
}
