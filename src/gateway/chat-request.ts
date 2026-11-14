import { EFFORT_PROVIDER_DEFAULT } from "../config/schema.js";
import { agentMessageText } from "./input.js";
import { decodeReasoningTag } from "./tags.js";
import { customInputToArguments, flattenTools, isRecord, type ToolNames } from "./tools.js";
import type { ResolvedProvider } from "./types.js";

export interface ResponsesRequest {
  model?: unknown;
  instructions?: unknown;
  input?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  parallel_tool_calls?: unknown;
  reasoning?: unknown;
  text?: unknown;
  max_output_tokens?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  stream?: unknown;
  [key: string]: unknown;
}

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } };

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  reasoning?: string;
  reasoning_details?: unknown[];
}

export interface ChatTranslation {
  body: Record<string, unknown>;
  names: ToolNames;
  droppedTools: string[];
}

const IMAGE_PLACEHOLDER = "[image omitted: this model accepts text only]";
const MISSING_OUTPUT = "[no output was recorded for this tool call]";

export function toChatRequest(
  request: ResponsesRequest,
  provider: ResolvedProvider,
): ChatTranslation {
  const { functions, names, dropped } = flattenTools(request.tools);
  const messages = normalizeMessages(buildMessages(request, provider, names));

  const body: Record<string, unknown> = {
    model: provider.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (functions.length > 0) {
    body["tools"] = functions.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: cleanSchema(tool.parameters),
      },
    }));
    const choice = chatToolChoice(request.tool_choice, names);
    if (choice !== undefined) body["tool_choice"] = choice;
    if (typeof request.parallel_tool_calls === "boolean") {
      body["parallel_tool_calls"] = request.parallel_tool_calls;
    }
  }

  const effort = resolveEffort(request, provider);
  if (effort !== undefined) body["reasoning_effort"] = effort;

  const format = responseFormat(request.text);
  if (format !== undefined) body["response_format"] = format;

  const maxTokens = maxOutputTokens(request, provider);
  if (maxTokens !== undefined) body["max_tokens"] = maxTokens;
  if (typeof request.temperature === "number") body["temperature"] = request.temperature;
  if (typeof request.top_p === "number") body["top_p"] = request.top_p;

  applyCompat(body, provider);
  return { body, names, droppedTools: dropped };
}

export function resolveEffort(
  request: ResponsesRequest,
  provider: ResolvedProvider,
): string | undefined {
  if (provider.reasoningEffort === EFFORT_PROVIDER_DEFAULT) return undefined;
  if (provider.reasoningEffort !== undefined) return provider.reasoningEffort;
  const requested = isRecord(request.reasoning) ? request.reasoning["effort"] : undefined;
  if (typeof requested !== "string" || requested === "") return undefined;
  return requested === EFFORT_PROVIDER_DEFAULT ? undefined : requested;
}

function maxOutputTokens(
  request: ResponsesRequest,
  provider: ResolvedProvider,
): number | undefined {
  const requested =
    typeof request.max_output_tokens === "number" ? request.max_output_tokens : undefined;
  if (requested !== undefined && provider.maxOutputTokens !== undefined) {
    return Math.min(requested, provider.maxOutputTokens);
  }
  return requested ?? provider.maxOutputTokens;
}

export function applyCompat(body: Record<string, unknown>, provider: ResolvedProvider): void {
  for (const name of provider.compat.omitParams) delete body[name];
  for (const [key, value] of Object.entries(provider.compat.extraBody)) body[key] = value;
}

function chatToolChoice(choice: unknown, names: ToolNames): unknown {
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  if (isRecord(choice) && (choice["type"] === "function" || choice["type"] === "custom")) {
    const name = choice["name"];
    if (typeof name === "string") {
      const namespace = typeof choice["namespace"] === "string" ? choice["namespace"] : undefined;
      return { type: "function", function: { name: names.flatten(name, namespace) } };
    }
  }
  return choice === undefined ? undefined : "auto";
}

function responseFormat(text: unknown): unknown {
  if (!isRecord(text) || !isRecord(text["format"])) return undefined;
  const format = text["format"];
  if (format["type"] === "json_object") return { type: "json_object" };
  if (format["type"] === "json_schema" && isRecord(format["schema"])) {
    return {
      type: "json_schema",
      json_schema: {
        name: typeof format["name"] === "string" ? format["name"] : "response",
        schema: format["schema"],
        ...(typeof format["strict"] === "boolean" ? { strict: format["strict"] } : {}),
      },
    };
  }
  return undefined;
}

export function cleanSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!isRecord(schema)) return schema;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "encrypted" && typeof value === "boolean") continue;
    cleaned[key] = cleanSchema(value);
  }
  return cleaned;
}

interface AssistantDraft {
  text: string[];
  toolCalls: ChatToolCall[];
  reasoningField: "reasoning_content" | "reasoning" | undefined;
  reasoningText: string[];
  reasoningDetails: unknown[];
}

function buildMessages(
  request: ResponsesRequest,
  provider: ResolvedProvider,
  names: ToolNames,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (typeof request.instructions === "string" && request.instructions.trim() !== "") {
    messages.push({ role: "system", content: request.instructions });
  }

  let draft: AssistantDraft | null = null;
  const assistant = (): AssistantDraft => {
    draft ??= {
      text: [],
      toolCalls: [],
      reasoningField: undefined,
      reasoningText: [],
      reasoningDetails: [],
    };
    return draft;
  };
  const flush = (): void => {
    if (draft === null) return;
    const current: AssistantDraft = draft;
    draft = null;
    const text = current.text.join("\n\n");
    if (text === "" && current.toolCalls.length === 0) return;
    const message: ChatMessage = { role: "assistant", content: text === "" ? null : text };
    if (current.toolCalls.length > 0) message.tool_calls = current.toolCalls;
    if (current.reasoningField !== undefined && current.reasoningText.length > 0) {
      message[current.reasoningField] = current.reasoningText.join("\n\n");
    }
    if (current.reasoningDetails.length > 0) message.reasoning_details = current.reasoningDetails;
    messages.push(message);
  };

  const input = request.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;

  for (const item of input) {
    if (!isRecord(item)) continue;
    const type = typeof item["type"] === "string" ? item["type"] : "message";
    switch (type) {
      case "message": {
        const role = item["role"];
        if (role === "assistant") {
          const text = textOf(item["content"]);
          if (text !== "") assistant().text.push(text);
        } else {
          flush();
          const content = userContent(item["content"], provider.compat.images);
          if (content !== null) {
            messages.push({ role: role === "user" ? "user" : "system", content });
          }
        }
        break;
      }
      case "reasoning": {
        const tag = decodeReasoningTag(item["encrypted_content"]);
        if (tag === null || tag.provider !== provider.name) break;
        const target = assistant();
        const text = tag.text ?? summaryText(item);
        if (tag.field !== undefined && text !== "") {
          target.reasoningField = tag.field;
          target.reasoningText.push(text);
        }
        if (tag.details !== undefined) target.reasoningDetails.push(...tag.details);
        break;
      }
      case "function_call": {
        const callId = stringOr(item["call_id"], item["id"]);
        const name = item["name"];
        if (callId === undefined || typeof name !== "string") break;
        const namespace = typeof item["namespace"] === "string" ? item["namespace"] : undefined;
        assistant().toolCalls.push({
          id: callId,
          type: "function",
          function: {
            name: names.flatten(name, namespace),
            arguments: argumentsText(item["arguments"]),
          },
        });
        break;
      }
      case "custom_tool_call": {
        const callId = stringOr(item["call_id"], item["id"]);
        const name = item["name"];
        if (callId === undefined || typeof name !== "string") break;
        const namespace = typeof item["namespace"] === "string" ? item["namespace"] : undefined;
        assistant().toolCalls.push({
          id: callId,
          type: "function",
          function: {
            name: names.flatten(name, namespace),
            arguments: customInputToArguments(
              typeof item["input"] === "string" ? item["input"] : "",
            ),
          },
        });
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const callId = stringOr(item["call_id"]);
        if (callId === undefined) break;
        flush();
        const { text, images } = toolOutput(item["output"]);
        messages.push({ role: "tool", tool_call_id: callId, content: text });
        if (images.length > 0) {
          messages.push({
            role: "user",
            content: provider.compat.images
              ? [{ type: "text", text: "Image output of the previous tool call:" }, ...images]
              : IMAGE_PLACEHOLDER,
          });
        }
        break;
      }
      case "agent_message": {
        const text = agentMessageText(item);
        if (text === "") break;
        flush();
        messages.push({ role: "user", content: text });
        break;
      }
      default:
        break;
    }
  }
  flush();
  return messages;
}

function summaryText(item: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["summary", "content"]) {
    const entries = item[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (isRecord(entry) && typeof entry["text"] === "string") parts.push(entry["text"]);
    }
    if (parts.length > 0) break;
  }
  return parts.join("\n\n");
}

function stringOr(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function argumentsText(value: unknown): string {
  if (typeof value === "string") return value.trim() === "" ? "{}" : value;
  if (value === undefined || value === null) return "{}";
  return JSON.stringify(value);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (typeof part["text"] === "string") parts.push(part["text"]);
    else if (typeof part["refusal"] === "string") parts.push(part["refusal"]);
  }
  return parts.join("");
}

function userContent(content: unknown, images: boolean): string | ChatContentPart[] | null {
  if (typeof content === "string") return content === "" ? null : content;
  if (!Array.isArray(content)) return null;
  const parts: ChatContentPart[] = [];
  let hasImage = false;
  for (const part of content) {
    if (!isRecord(part)) continue;
    const type = part["type"];
    if (
      (type === "input_text" || type === "output_text" || type === "text") &&
      typeof part["text"] === "string"
    ) {
      parts.push({ type: "text", text: part["text"] });
    } else if (type === "input_image") {
      const image = imagePart(part);
      if (image !== null && images) {
        parts.push(image);
        hasImage = true;
      } else {
        parts.push({ type: "text", text: IMAGE_PLACEHOLDER });
      }
    } else if (type === "input_file") {
      parts.push({ type: "text", text: "[file attachment omitted]" });
    }
  }
  if (parts.length === 0) return null;
  if (!hasImage) {
    return parts.map((part) => (part.type === "text" ? part.text : "")).join("\n\n");
  }
  return parts;
}

function imagePart(part: Record<string, unknown>): ChatContentPart | null {
  const url = part["image_url"];
  if (typeof url !== "string" || url === "") return null;
  const detail = part["detail"];
  return {
    type: "image_url",
    image_url: typeof detail === "string" && detail !== "original" ? { url, detail } : { url },
  };
}

function toolOutput(output: unknown): { text: string; images: ChatContentPart[] } {
  if (typeof output === "string") return { text: output, images: [] };
  if (Array.isArray(output)) {
    const text: string[] = [];
    const images: ChatContentPart[] = [];
    for (const part of output) {
      if (!isRecord(part)) continue;
      if (typeof part["text"] === "string") text.push(part["text"]);
      else if (part["type"] === "input_image") {
        const image = imagePart(part);
        if (image !== null) images.push(image);
      }
    }
    return { text: text.join("\n"), images };
  }
  if (isRecord(output) && typeof output["content"] === "string")
    return { text: output["content"], images: [] };
  return {
    text: output === undefined || output === null ? "" : JSON.stringify(output),
    images: [],
  };
}

export function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
  const leading: string[] = [];
  let index = 0;
  while (index < messages.length && messages[index]!.role === "system") {
    const text = contentText(messages[index]!.content);
    if (text !== "") leading.push(text);
    index++;
  }
  const result: ChatMessage[] = [];
  if (leading.length > 0) result.push({ role: "system", content: leading.join("\n\n") });

  const rest = messages
    .slice(index)
    .map((message): ChatMessage =>
      message.role === "system" ? { role: "user", content: message.content } : message,
    );

  for (let position = 0; position < rest.length; position++) {
    const message = rest[position]!;
    if (message.role === "tool") {
      continue;
    }
    if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
      result.push(message);
      const wanted = new Map(message.tool_calls.map((call) => [call.id, false]));
      let cursor = position + 1;
      const deferred: ChatMessage[] = [];
      while (cursor < rest.length) {
        const next = rest[cursor]!;
        if (
          next.role === "tool" &&
          next.tool_call_id !== undefined &&
          wanted.has(next.tool_call_id)
        ) {
          if (!wanted.get(next.tool_call_id)) {
            wanted.set(next.tool_call_id, true);
            result.push(next);
          }
          cursor++;
        } else if (next.role === "user" && [...wanted.values()].some((answered) => !answered)) {
          const upcoming = rest[cursor + 1];
          if (
            upcoming?.role === "tool" &&
            upcoming.tool_call_id !== undefined &&
            wanted.has(upcoming.tool_call_id)
          ) {
            deferred.push(next);
            cursor++;
          } else break;
        } else break;
      }
      for (const [id, answered] of wanted) {
        if (!answered) result.push({ role: "tool", tool_call_id: id, content: MISSING_OUTPUT });
      }
      for (const extra of deferred) pushMerged(result, extra);
      position = cursor - 1;
      continue;
    }
    pushMerged(result, message);
  }
  return result;
}

function pushMerged(result: ChatMessage[], message: ChatMessage): void {
  const previous = result.at(-1);
  if (message.role === "user" && previous?.role === "user") {
    previous.content = mergeContent(previous.content, message.content);
    return;
  }
  result.push(message);
}

function mergeContent(
  first: ChatMessage["content"],
  second: ChatMessage["content"],
): string | ChatContentPart[] | null {
  if (typeof first === "string" && typeof second === "string") return `${first}\n\n${second}`;
  const parts = [...toParts(first), ...toParts(second)];
  return parts.length === 0 ? null : parts;
}

function toParts(content: ChatMessage["content"]): ChatContentPart[] {
  if (content === null) return [];
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  return content;
}

function contentText(content: ChatMessage["content"]): string {
  if (content === null) return "";
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : "")).join("\n\n");
}
