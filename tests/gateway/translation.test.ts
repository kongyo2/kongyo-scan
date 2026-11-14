import { describe, expect, it } from "vitest";

import { namespaceAliases, prepareResponsesBody } from "../../src/gateway/attempts.js";
import {
  type ChatMessage,
  normalizeMessages,
  toChatRequest,
} from "../../src/gateway/chat-request.js";
import { ChatStreamTranslator } from "../../src/gateway/chat-stream.js";
import { SseParser } from "../../src/gateway/sse.js";
import { decodeReasoningTag, encodeReasoningTag } from "../../src/gateway/tags.js";
import { flattenTools, ToolNames } from "../../src/gateway/tools.js";
import { chatChunk, provider } from "../helpers.js";

const functionTool = (
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: "function",
  name,
  description: `${name} description`,
  strict: false,
  parameters: {
    type: "object",
    properties: { value: { type: "string", encrypted: true } },
    required: ["value"],
  },
  ...extra,
});

const codexTools = [
  functionTool("exec_command"),
  {
    type: "namespace",
    name: "collaboration",
    description: "Agents",
    tools: [functionTool("spawn_agent"), functionTool("exec_command")],
  },
  {
    type: "namespace",
    name: "mcp__codex_security",
    description: "Security",
    tools: [functionTool("record_scan_draft")],
  },
  {
    type: "custom",
    name: "apply_patch",
    description: "Apply a patch",
    format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
  },
  { type: "web_search", external_web_access: false },
];

describe("SseParser", () => {
  it("parses events split across arbitrary chunks and line endings", () => {
    const parser = new SseParser();
    const text = 'event: a\r\ndata: {"x":1}\r\n\r\n: comment\ndata: one\ndata: two\n\ndata: tail';
    const messages = [];
    for (const character of text) messages.push(...parser.push(character));
    messages.push(...parser.flush());
    expect(messages).toEqual([
      { event: "a", data: '{"x":1}' },
      { event: undefined, data: "one\ntwo" },
      { event: undefined, data: "tail" },
    ]);
  });
});

describe("reasoning tags", () => {
  it("round-trips provider, original content, and chat details", () => {
    const tag = {
      provider: "primary",
      encrypted: "opaque:with:colons",
      field: "reasoning_content" as const,
      details: [{ type: "reasoning.encrypted", data: "x" }],
    };
    expect(decodeReasoningTag(encodeReasoningTag(tag))).toEqual(tag);
  });

  it("ignores values it did not produce", () => {
    expect(decodeReasoningTag("gAAAAB-opaque")).toBeNull();
    expect(decodeReasoningTag(undefined)).toBeNull();
    expect(decodeReasoningTag("kscan1:not-base64-json:")).toBeNull();
  });
});

describe("flattenTools", () => {
  it("expands namespaces, converts free-form tools, and drops hosted tools", () => {
    const { functions, names, dropped } = flattenTools(codexTools);
    expect(functions.map((tool) => tool.name)).toEqual([
      "exec_command",
      "apply_patch",
      "spawn_agent",
      "collaboration__exec_command",
      "record_scan_draft",
    ]);
    expect(dropped).toEqual(["web_search"]);
    expect(names.resolve("spawn_agent")).toEqual({
      name: "spawn_agent",
      namespace: "collaboration",
      kind: "function",
    });
    expect(names.resolve("collaboration__exec_command")).toEqual({
      name: "exec_command",
      namespace: "collaboration",
      kind: "function",
    });
    expect(names.flatten("exec_command", "collaboration")).toBe("collaboration__exec_command");
    expect(names.resolve("apply_patch").kind).toBe("custom");
    const custom = functions.find((tool) => tool.name === "apply_patch")!;
    expect(custom.parameters).toMatchObject({ required: ["input"] });
    expect(custom.description).toContain("lark grammar");
  });

  it("keeps function names within the limits endpoints enforce", () => {
    const names = new ToolNames();
    const flat = names.register({
      name: `tool with spaces ${"x".repeat(80)}`,
      namespace: undefined,
      kind: "function",
    });
    expect(flat).toMatch(/^[A-Za-z0-9_-]{1,64}$/u);
  });
});

describe("toChatRequest", () => {
  const request = {
    model: "codex-model",
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "session",
    client_metadata: { a: "b" },
    tools: codexTools,
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: "xhigh", summary: "detailed" },
    input: [
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Base instructions" }],
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "More instructions" }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Environment" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Scan the repo" }] },
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "thinking hard" }],
        encrypted_content: encodeReasoningTag({ provider: "primary", field: "reasoning_content" }),
      },
      {
        type: "reasoning",
        id: "rs_2",
        summary: [],
        encrypted_content: encodeReasoningTag({ provider: "someone-else", encrypted: "opaque" }),
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Looking around." }],
      },
      {
        type: "function_call",
        name: "spawn_agent",
        namespace: "collaboration",
        arguments: '{"value":"a"}',
        call_id: "call_a",
      },
      {
        type: "custom_tool_call",
        name: "apply_patch",
        input: "*** Begin Patch",
        call_id: "call_b",
      },
      { type: "function_call_output", call_id: "call_a", output: "agent started" },
      {
        type: "custom_tool_call_output",
        call_id: "call_b",
        output: [{ type: "input_text", text: "patched" }],
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "A late reminder" }],
      },
      { type: "web_search_call", id: "ws_1", status: "completed" },
    ],
  };

  it("builds a chat request that strict endpoints accept", () => {
    const { body, droppedTools } = toChatRequest(request, provider());
    expect(droppedTools).toEqual(["web_search"]);
    expect(body).toMatchObject({
      model: "test-model",
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: "xhigh",
      tool_choice: "auto",
      parallel_tool_calls: true,
    });
    for (const key of ["store", "include", "prompt_cache_key", "client_metadata", "input"])
      expect(body).not.toHaveProperty(key);

    const tools = body["tools"] as { function: { name: string; parameters: unknown } }[];
    expect(tools.map((tool) => tool.function.name)).toContain("record_scan_draft");
    expect(JSON.stringify(tools)).not.toContain("encrypted");

    const messages = body["messages"] as ChatMessage[];
    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "tool",
      "user",
    ]);
    expect(messages[0]!.content).toBe("Base instructions\n\nMore instructions");
    expect(messages[1]!.content).toBe("Environment\n\nScan the repo");
    const assistant = messages[2]!;
    expect(assistant.content).toBe("Looking around.");
    expect(assistant.reasoning_content).toBe("thinking hard");
    expect(assistant.tool_calls).toEqual([
      {
        id: "call_a",
        type: "function",
        function: { name: "spawn_agent", arguments: '{"value":"a"}' },
      },
      {
        id: "call_b",
        type: "function",
        function: { name: "apply_patch", arguments: '{"input":"*** Begin Patch"}' },
      },
    ]);
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "call_a", content: "agent started" });
    expect(messages[4]).toEqual({ role: "tool", tool_call_id: "call_b", content: "patched" });
    expect(messages[5]).toEqual({ role: "user", content: "A late reminder" });
  });

  it("delivers messages between agents as ordinary user messages", () => {
    const { body } = toChatRequest(
      {
        model: "codex-model",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "Scan it" }] },
          {
            type: "function_call",
            name: "spawn_agent",
            namespace: "collaboration",
            arguments: '{"message":"Review src/auth.js."}',
            call_id: "call_a",
          },
          { type: "function_call_output", call_id: "call_a", output: '{"task_name":"/root/w"}' },
          {
            type: "agent_message",
            author: "/root/w",
            recipient: "/root",
            content: [
              {
                type: "input_text",
                text: "Message Type: FINAL_ANSWER\nSender: /root/w\nPayload:\nNo issues.",
              },
            ],
          },
        ],
        tools: codexTools,
      },
      provider(),
    );
    const messages = body["messages"] as ChatMessage[];
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(messages[3]!.content).toBe(
      "Message Type: FINAL_ANSWER\nSender: /root/w\nPayload:\nNo issues.",
    );
  });

  it("applies the provider's effort override, limits, and compatibility switches", () => {
    const { body } = toChatRequest(
      { ...request, max_output_tokens: 9000 },
      provider({
        reasoningEffort: "default",
        maxOutputTokens: 4000,
        compat: {
          nativeResponses: true,
          images: true,
          omitParams: ["parallel_tool_calls", "stream_options"],
          extraBody: { enable_thinking: true },
        },
      }),
    );
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("parallel_tool_calls");
    expect(body).not.toHaveProperty("stream_options");
    expect(body).toMatchObject({ max_tokens: 4000, enable_thinking: true });
    expect(
      toChatRequest(request, provider({ reasoningEffort: "max" })).body["reasoning_effort"],
    ).toBe("max");
  });

  it("replaces images for text-only models and keeps them otherwise", () => {
    const withImage = {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "look" },
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          ],
        },
      ],
    };
    const kept = toChatRequest(withImage, provider()).body["messages"] as ChatMessage[];
    expect(kept[0]!.content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
    const stripped = toChatRequest(
      withImage,
      provider({ compat: { nativeResponses: true, images: false, omitParams: [], extraBody: {} } }),
    ).body["messages"] as ChatMessage[];
    expect(stripped[0]!.content).toBe("look\n\n[image omitted: this model accepts text only]");
  });

  it("maps a structured output schema to response_format", () => {
    const { body } = toChatRequest(
      {
        input: "hi",
        text: {
          format: { type: "json_schema", name: "result", strict: true, schema: { type: "object" } },
        },
      },
      provider(),
    );
    expect(body["response_format"]).toEqual({
      type: "json_schema",
      json_schema: { name: "result", schema: { type: "object" }, strict: true },
    });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });
});

describe("normalizeMessages", () => {
  it("answers unanswered tool calls and drops orphaned results", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "tool", tool_call_id: "ghost", content: "orphan" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "a", type: "function", function: { name: "f", arguments: "{}" } },
          { id: "b", type: "function", function: { name: "f", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "done" },
      { role: "user", content: "next" },
    ];
    const normalized = normalizeMessages(messages);
    expect(normalized.map((message) => `${message.role}:${message.tool_call_id ?? ""}`)).toEqual([
      "user:",
      "assistant:",
      "tool:a",
      "tool:b",
      "user:",
    ]);
    expect(normalized[3]!.content).toContain("no output was recorded");
  });
});

describe("ChatStreamTranslator", () => {
  function translate(
    chunks: Record<string, unknown>[],
    names = flattenTools(codexTools).names,
  ): {
    events: { event: string; data: Record<string, unknown> }[];
    translator: ChatStreamTranslator;
  } {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const translator = new ChatStreamTranslator({
      providerName: "primary",
      model: "test-model",
      names,
      emit: (event, data) => events.push({ event, data }),
      requestCharacters: 4000,
    });
    for (const chunk of chunks) translator.feed(chunk);
    return { events, translator };
  }
  const doneItems = (
    events: { event: string; data: Record<string, unknown> }[],
  ): Record<string, unknown>[] =>
    events
      .filter((item) => item.event === "response.output_item.done")
      .map((item) => item.data["item"] as Record<string, unknown>);

  it("turns reasoning, text, and tool calls into Responses items in order", () => {
    const { events, translator } = translate([
      chatChunk({ role: "assistant" }),
      chatChunk({ reasoning_content: "Let me " }),
      chatChunk({ reasoning_content: "think." }),
      chatChunk({ content: "I'll check." }),
      chatChunk({
        tool_calls: [
          {
            index: 0,
            id: "call-abcdef-123456",
            type: "function",
            function: { name: "spawn_agent", arguments: "" },
          },
        ],
      }),
      chatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"value":' } }] }),
      chatChunk({
        tool_calls: [
          { index: 0, function: { arguments: '"x"}' } },
          {
            index: 1,
            id: "call-zzzzzz-999999",
            function: { name: "apply_patch", arguments: '{"input":"*** Begin Patch"}' },
          },
        ],
      }),
      chatChunk({}, "tool_calls"),
      {
        id: "chatcmpl-1",
        choices: [],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 80,
          total_tokens: 1280,
          prompt_tokens_details: { cached_tokens: 1000 },
          completion_tokens_details: { reasoning_tokens: 30 },
        },
      },
    ]);
    expect(translator.finished).toBe(true);
    expect(translator.hasOutput).toBe(true);
    const { usage } = translator.complete();
    expect(usage).toEqual({
      inputTokens: 1200,
      cachedInputTokens: 1000,
      outputTokens: 80,
      reasoningTokens: 30,
      totalTokens: 1280,
      estimated: false,
    });

    expect(events[0]!.event).toBe("response.created");
    expect(events.at(-1)!.event).toBe("response.completed");
    const items = doneItems(events);
    expect(items.map((item) => item["type"])).toEqual([
      "reasoning",
      "message",
      "function_call",
      "custom_tool_call",
    ]);
    expect(items[0]).toMatchObject({ summary: [{ type: "summary_text", text: "Let me think." }] });
    expect(decodeReasoningTag(items[0]!["encrypted_content"])).toEqual({
      provider: "primary",
      field: "reasoning_content",
    });
    expect(items[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "output_text", text: "I'll check." }],
    });
    expect(items[2]).toMatchObject({
      name: "spawn_agent",
      namespace: "collaboration",
      call_id: "call-abcdef-123456",
      arguments: '{"value":"x"}',
    });
    expect(items[3]).toMatchObject({
      name: "apply_patch",
      input: "*** Begin Patch",
      call_id: "call-zzzzzz-999999",
    });

    const completed = events.at(-1)!.data["response"] as Record<string, unknown>;
    expect(completed["output"]).toHaveLength(4);
    expect(completed["usage"]).toMatchObject({
      input_tokens: 1200,
      input_tokens_details: { cached_tokens: 1000 },
      output_tokens: 80,
    });
    const sequence = events.map((item) => item.data["sequence_number"] as number);
    expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
  });

  it("moves a leading <think> block into reasoning even when split across chunks", () => {
    const { events, translator } = translate([
      chatChunk({ content: "<th" }),
      chatChunk({ content: "ink>plan the " }),
      chatChunk({ content: "work</thi" }),
      chatChunk({ content: "nk>\n\nAnswer." }),
      chatChunk({}, "stop"),
    ]);
    translator.complete();
    const items = doneItems(events);
    expect(items.map((item) => item["type"])).toEqual(["reasoning", "message"]);
    expect(items[0]).toMatchObject({ summary: [{ text: "plan the work" }] });
    expect(items[1]).toMatchObject({ content: [{ text: "Answer." }] });
  });

  it("keeps ordinary text that merely starts with an angle bracket", () => {
    const { events, translator } = translate([
      chatChunk({ content: "<" }),
      chatChunk({ content: "div> markup" }),
      chatChunk({}, "stop"),
    ]);
    translator.complete();
    expect(doneItems(events)[0]).toMatchObject({
      type: "message",
      content: [{ text: "<div> markup" }],
    });
  });

  it("preserves OpenRouter-style reasoning details for the next request", () => {
    const { events, translator } = translate([
      chatChunk({ content: "pong" }),
      chatChunk({
        reasoning_details: [{ type: "reasoning.encrypted", index: 0, id: "rs_x", data: "abc" }],
      }),
      chatChunk({ reasoning_details: [{ type: "reasoning.encrypted", index: 0, data: "def" }] }),
      chatChunk({}, "stop"),
    ]);
    translator.complete();
    const items = doneItems(events);
    expect(items.map((item) => item["type"])).toEqual(["message", "reasoning"]);
    expect(decodeReasoningTag(items[1]!["encrypted_content"])).toEqual({
      provider: "primary",
      details: [{ type: "reasoning.encrypted", index: 0, id: "rs_x", data: "abcdef" }],
    });
  });

  it("mints call IDs when the endpoint sends short or repeated ones, and estimates missing usage", () => {
    const { events, translator } = translate([
      chatChunk({
        tool_calls: [
          { index: 0, id: "0", function: { name: "exec_command", arguments: "{}" } },
          { index: 1, id: "0", function: { name: "exec_command" } },
        ],
      }),
      chatChunk({}, "tool_calls"),
    ]);
    const { usage } = translator.complete();
    const items = doneItems(events);
    expect(items).toHaveLength(2);
    expect(items[0]!["call_id"]).not.toBe(items[1]!["call_id"]);
    expect(String(items[0]!["call_id"])).toMatch(/^call_[0-9a-f]{32}$/u);
    expect(items[1]!["arguments"]).toBe("{}");
    expect(usage).toMatchObject({ inputTokens: 1000, estimated: true });
  });

  it("reports no output when the model returned nothing", () => {
    const { translator } = translate([
      chatChunk({ role: "assistant" }),
      chatChunk({ content: "  \n" }),
      chatChunk({}, "stop"),
    ]);
    expect(translator.hasOutput).toBe(false);
  });
});

describe("prepareResponsesBody", () => {
  const request = {
    model: "codex-model",
    tools: codexTools,
    reasoning: { effort: "xhigh", summary: "detailed" },
    input: [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [],
        encrypted_content: encodeReasoningTag({
          provider: "primary",
          encrypted: "opaque-original",
        }),
      },
      {
        type: "reasoning",
        id: "rs_2",
        summary: [],
        encrypted_content: encodeReasoningTag({ provider: "other", encrypted: "foreign" }),
      },
      { type: "reasoning", id: "rs_3", summary: [], encrypted_content: "untagged-from-elsewhere" },
      {
        type: "function_call",
        name: "spawn_agent",
        namespace: "collaboration",
        arguments: "{}",
        call_id: "c1",
      },
    ],
  };

  it("restores this provider's reasoning and drops reasoning from other providers", () => {
    const { body, names } = prepareResponsesBody(
      request,
      provider({
        wireApi: "responses",
        reasoningEffort: "max",
        compat: { nativeResponses: true, images: true, omitParams: [], extraBody: {} },
      }),
    );
    expect(names).toBeNull();
    expect(body["model"]).toBe("test-model");
    expect(body["reasoning"]).toEqual({ effort: "max", summary: "detailed" });
    expect(body["tools"]).toBe(codexTools);
    const input = body["input"] as Record<string, unknown>[];
    expect(input.map((item) => item["id"] ?? item["name"])).toEqual([
      "rs_1",
      "rs_3",
      "spawn_agent",
    ]);
    expect(input[0]!["encrypted_content"]).toBe("opaque-original");
    expect(input[2]).toMatchObject({ namespace: "collaboration" });
  });

  it('never sends kongyo-scan\'s own "default" effort to an endpoint', () => {
    const asked = { ...request, reasoning: { effort: "default", summary: "detailed" } };
    expect(
      prepareResponsesBody(asked, provider({ wireApi: "responses" })).body["reasoning"],
    ).toEqual({ summary: "detailed" });
    expect(
      prepareResponsesBody(asked, provider({ wireApi: "responses", reasoningEffort: "high" })).body[
        "reasoning"
      ],
    ).toEqual({ effort: "high", summary: "detailed" });
    expect(
      prepareResponsesBody(request, provider({ wireApi: "responses", reasoningEffort: "default" }))
        .body["reasoning"],
    ).toEqual({ summary: "detailed" });
    expect(toChatRequest(asked, provider()).body).not.toHaveProperty("reasoning_effort");
  });

  it("keeps the output-token request within the provider's limit", () => {
    const limited = provider({ wireApi: "responses", maxOutputTokens: 100 });
    const tokens = (requested: number | undefined, target = limited): unknown =>
      prepareResponsesBody(
        requested === undefined ? request : { ...request, max_output_tokens: requested },
        target,
      ).body["max_output_tokens"];
    expect(tokens(1000)).toBe(100);
    expect(tokens(50)).toBe(50);
    expect(tokens(undefined)).toBe(100);
    expect(tokens(1000, provider({ wireApi: "responses" }))).toBe(1000);
    expect(tokens(undefined, provider({ wireApi: "responses" }))).toBeUndefined();
  });

  it("flattens tools and history for endpoints other than OpenAI's own", () => {
    const { body, names } = prepareResponsesBody(request, provider({ wireApi: "responses" }));
    expect(names).not.toBeNull();
    const tools = body["tools"] as Record<string, unknown>[];
    expect(tools.every((tool) => tool["type"] === "function")).toBe(true);
    expect(tools.map((tool) => tool["name"])).toContain("record_scan_draft");
    const call = (body["input"] as Record<string, unknown>[]).find(
      (item) => item["type"] === "function_call",
    )!;
    expect(call).not.toHaveProperty("namespace");
    expect(call["name"]).toBe("spawn_agent");
  });

  it("rewrites agent messages and drops items only OpenAI's backend accepts", () => {
    const multiAgent = {
      model: "codex-model",
      tools: codexTools,
      input: [
        {
          type: "agent_message",
          author: "/root",
          recipient: "/root/worker",
          content: [
            { type: "input_text", text: "Message Type: NEW_TASK\nSender: /root\nPayload:\n" },
            { type: "encrypted_content", encrypted_content: "Review src/auth.js." },
          ],
        },
        { type: "agent_message", author: "/root", recipient: "/root/worker", content: [] },
        { type: "compaction", encrypted_content: "opaque" },
        { type: "tool_search_call", call_id: "ts_1", execution: "client", arguments: {} },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    };
    const portable = prepareResponsesBody(multiAgent, provider({ wireApi: "responses" })).body;
    expect(portable["input"]).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Message Type: NEW_TASK\nSender: /root\nPayload:\nReview src/auth.js.",
          },
        ],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ]);

    const native = prepareResponsesBody(
      multiAgent,
      provider({
        wireApi: "responses",
        compat: { nativeResponses: true, images: true, omitParams: [], extraBody: {} },
      }),
    ).body;
    expect(native["input"]).toEqual(multiAgent.input);
  });

  it("recognizes the spellings endpoints use for namespaced tool calls", () => {
    const aliases = namespaceAliases(codexTools);
    expect(aliases.get("collaboration.spawn_agent")).toEqual({
      name: "spawn_agent",
      namespace: "collaboration",
    });
    expect(aliases.get("mcp__codex_security__record_scan_draft")).toEqual({
      name: "record_scan_draft",
      namespace: "mcp__codex_security",
    });
    expect(aliases.get("exec_command")).toBeUndefined();
  });
});
