import { afterEach, describe, expect, it } from "vitest";

import { ProviderChain } from "../../src/gateway/chain.js";
import { type Gateway, startGateway } from "../../src/gateway/server.js";
import { decodeReasoningTag } from "../../src/gateway/tags.js";
import type { GatewayEvent, ResolvedProvider } from "../../src/gateway/types.js";
import { closeUpstreamDispatcher } from "../../src/gateway/upstream.js";
import {
  chatChunk,
  type FakeUpstream,
  fakeUpstream,
  parseSseText,
  provider,
  sendSse,
} from "../helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  await closeUpstreamDispatcher();
});

async function upstream(handler: Parameters<typeof fakeUpstream>[0]): Promise<FakeUpstream> {
  const server = await fakeUpstream(handler);
  cleanup.push(() => server.close());
  return server;
}

async function gateway(
  providers: ResolvedProvider[],
  events: GatewayEvent[] = [],
): Promise<Gateway> {
  const instance = await startGateway({
    providers,
    cooldownMs: 60_000,
    idleTimeoutMs: 2_000,
    observer: (event) => events.push(event),
  });
  cleanup.push(() => instance.close());
  return instance;
}

const REQUEST = {
  model: "codex-model",
  stream: true,
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
  tools: [
    {
      type: "namespace",
      name: "collab",
      description: "",
      tools: [
        { type: "function", name: "spawn_agent", parameters: { type: "object", properties: {} } },
      ],
    },
  ],
  reasoning: { effort: "high" },
};

async function post(
  instance: Gateway,
  body: unknown = REQUEST,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; contentType: string }> {
  const response = await fetch(`${instance.baseUrl}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${instance.token}`,
      "content-type": "application/json",
      "session-id": "session-123",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    text: await response.text(),
    contentType: response.headers.get("content-type") ?? "",
  };
}

const chatAnswer =
  (text: string) =>
  (_request: unknown, response: import("node:http").ServerResponse): void =>
    sendSse(
      response,
      [
        [undefined, chatChunk({ content: text })],
        [undefined, chatChunk({}, "stop")],
        [
          undefined,
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
        ],
      ],
      true,
    );

describe("gateway", () => {
  it("rejects requests without the per-run token", async () => {
    const instance = await gateway([provider()]);
    const missing = await fetch(`${instance.baseUrl}/responses`, { method: "POST", body: "{}" });
    expect(missing.status).toBe(401);
    const wrong = await fetch(`${instance.baseUrl}/responses`, {
      method: "POST",
      headers: { authorization: "Bearer nope" },
      body: "{}",
    });
    expect(wrong.status).toBe(401);
    expect(instance.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
  });

  it("translates a chat endpoint's stream and forwards identity headers", async () => {
    const chat = await upstream(chatAnswer("hi there"));
    const instance = await gateway([
      provider({
        baseUrl: chat.baseUrl,
        headers: { "x-session": "{session_id}", "x-key": "{api_key}" },
        queryParams: { "api-version": "1" },
      }),
    ]);
    const result = await post(instance);
    expect(result.status).toBe(200);
    expect(result.contentType).toContain("text/event-stream");
    const events = parseSseText(result.text);
    expect(events.map((item) => item.event)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const sent = chat.requests[0]!;
    expect(sent.url).toBe("/v1/chat/completions?api-version=1");
    expect(sent.headers["session-id"]).toBe("session-123");
    expect(sent.headers["x-session"]).toBe("session-123");
    expect(sent.headers["x-key"]).toBe("test-key");
    expect(sent.headers["authorization"]).toBeUndefined();
    expect(String(sent.headers["user-agent"])).toMatch(/^kongyo-scan\//u);
    expect(sent.body["model"]).toBe("test-model");
    expect((sent.body["tools"] as { function: { name: string } }[])[0]!.function.name).toBe(
      "spawn_agent",
    );
    expect(instance.usage().total).toMatchObject({ inputTokens: 10, outputTokens: 2 });
  });

  it("sends a compatible Responses endpoint plain tools and messages, and restores namespaces in its answer", async () => {
    const responses = await upstream((_request, response) =>
      sendSse(response, [
        [
          "response.created",
          { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
        ],
        [
          "response.output_item.done",
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_1",
              name: "spawn_agent",
              arguments: '{"message":"go"}',
              call_id: "call_2",
            },
          },
        ],
        [
          "response.completed",
          {
            type: "response.completed",
            response: {
              id: "resp_1",
              status: "completed",
              output: [],
              usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
            },
          },
        ],
      ]),
    );
    const instance = await gateway([
      provider({ wireApi: "responses", baseUrl: responses.baseUrl }),
    ]);
    const request = {
      ...REQUEST,
      tools: [...REQUEST.tools, { type: "web_search", external_web_access: false }],
      input: [
        ...REQUEST.input,
        {
          type: "function_call",
          name: "spawn_agent",
          namespace: "collab",
          arguments: "{}",
          call_id: "call_1",
        },
        { type: "function_call_output", call_id: "call_1", output: '{"task_name":"/root/worker"}' },
        {
          type: "agent_message",
          author: "/root/worker",
          recipient: "/root",
          content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nPayload:\ndone" }],
        },
        { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search" } },
      ],
    };
    const events = parseSseText((await post(instance, request)).text);

    const sent = responses.requests[0]!.body;
    expect(sent["tools"]).toEqual([
      {
        type: "function",
        name: "spawn_agent",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ]);
    const input = sent["input"] as Record<string, unknown>[];
    expect(input.map((item) => item["type"])).toEqual([
      "message",
      "function_call",
      "function_call_output",
      "message",
    ]);
    expect(input[1]).toEqual({
      type: "function_call",
      name: "spawn_agent",
      arguments: "{}",
      call_id: "call_1",
    });
    expect(input[3]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nPayload:\ndone" }],
    });

    const call = events.find((item) => item.event === "response.output_item.done")!.data[
      "item"
    ] as Record<string, unknown>;
    expect(call).toMatchObject({
      name: "spawn_agent",
      namespace: "collab",
      arguments: '{"message":"go"}',
    });
  });

  it("keeps OpenAI's native shape when asked, fixing namespaced call names and tagging reasoning", async () => {
    const responses = await upstream((_request, response) =>
      sendSse(response, [
        [
          "response.created",
          { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
        ],
        [
          "response.output_item.done",
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "reasoning",
              id: "rs_1",
              status: "completed",
              summary: [],
              encrypted_content: "opaque",
            },
          },
        ],
        [
          "response.output_item.done",
          {
            type: "response.output_item.done",
            output_index: 1,
            item: {
              type: "function_call",
              id: "fc_1",
              name: "collab.spawn_agent",
              arguments: "{}",
              call_id: "call_1",
            },
          },
        ],
        [
          "response.completed",
          {
            type: "response.completed",
            response: {
              id: "resp_1",
              status: "completed",
              output: [],
              usage: {
                input_tokens: 5,
                input_tokens_details: { cached_tokens: 3 },
                output_tokens: 1,
                total_tokens: 6,
              },
            },
          },
        ],
      ]),
    );
    const instance = await gateway([
      provider({
        wireApi: "responses",
        baseUrl: responses.baseUrl,
        compat: { nativeResponses: true, images: true, omitParams: [], extraBody: {} },
      }),
    ]);
    const events = parseSseText((await post(instance)).text);
    expect(responses.requests[0]!.body["tools"]).toEqual(REQUEST.tools);
    const items = events
      .filter((item) => item.event === "response.output_item.done")
      .map((item) => item.data["item"] as Record<string, unknown>);
    expect(decodeReasoningTag(items[0]!["encrypted_content"])).toEqual({
      provider: "primary",
      encrypted: "opaque",
    });
    expect(items[1]).toMatchObject({ name: "spawn_agent", namespace: "collab" });
    expect(responses.requests[0]!.url).toBe("/v1/responses");
    expect(responses.requests[0]!.headers["authorization"]).toBe("Bearer test-key");
    expect(instance.usage().total).toMatchObject({
      inputTokens: 5,
      cachedInputTokens: 3,
      outputTokens: 1,
    });
  });

  it("falls back down the chain and skips a failed provider while it cools down", async () => {
    const broken = await upstream((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "Invalid credential", code: "invalid_api_key" } }),
      );
    });
    const healthy = await upstream(chatAnswer("from the fallback"));
    const events: GatewayEvent[] = [];
    const instance = await gateway(
      [
        provider({ name: "first", baseUrl: broken.baseUrl }),
        provider({ name: "second", baseUrl: healthy.baseUrl, model: "other-model" }),
      ],
      events,
    );

    const first = await post(instance);
    expect(first.status).toBe(200);
    expect(first.text).toContain("from the fallback");
    expect(events.filter((event) => event.type === "fallback")).toMatchObject([
      { from: "first", to: "second", failure: { kind: "auth", status: 401 } },
    ]);
    expect(healthy.requests[0]!.body["model"]).toBe("other-model");

    await post(instance);
    expect(broken.requests).toHaveLength(1);
    expect(healthy.requests).toHaveLength(2);
    expect(
      instance.health().find((item) => item.provider === "first")!.coolingUntil,
    ).toBeGreaterThan(Date.now());
    const usage = instance.usage();
    expect(usage.providers.find((item) => item.provider === "first")).toMatchObject({
      requests: 0,
      failures: 1,
    });
    expect(usage.providers.find((item) => item.provider === "second")).toMatchObject({
      requests: 2,
    });
  });

  it("falls back when a stream fails before any output, without leaking the failed attempt", async () => {
    const failing = await upstream((_request, response) =>
      sendSse(response, [
        [
          "response.created",
          { type: "response.created", response: { id: "resp_x", status: "in_progress" } },
        ],
        [
          "response.failed",
          {
            type: "response.failed",
            response: {
              id: "resp_x",
              status: "failed",
              error: { code: "server_error", message: "upstream exploded" },
            },
          },
        ],
      ]),
    );
    const healthy = await upstream(chatAnswer("recovered"));
    const instance = await gateway([
      provider({ name: "first", wireApi: "responses", baseUrl: failing.baseUrl }),
      provider({ name: "second", baseUrl: healthy.baseUrl }),
    ]);
    const result = await post(instance);
    expect(result.text).not.toContain("resp_x");
    expect(result.text).not.toContain("upstream exploded");
    expect(parseSseText(result.text).at(-1)!.event).toBe("response.completed");
  });

  it("counts a Responses failure after partial output against the provider", async () => {
    const partial = (code: string, message: string) =>
      upstream((_request, response) =>
        sendSse(response, [
          [
            "response.created",
            { type: "response.created", response: { id: "resp_x", status: "in_progress" } },
          ],
          [
            "response.output_text.delta",
            { type: "response.output_text.delta", output_index: 0, delta: "partial" },
          ],
          [
            "response.failed",
            {
              type: "response.failed",
              response: { id: "resp_x", status: "failed", error: { code, message } },
            },
          ],
        ]),
      );
    const failing = await partial("server_error", "upstream exploded");
    const healthy = await upstream(chatAnswer("from the fallback"));
    const events: GatewayEvent[] = [];
    const instance = await gateway(
      [
        provider({ name: "first", wireApi: "responses", baseUrl: failing.baseUrl }),
        provider({ name: "second", baseUrl: healthy.baseUrl }),
      ],
      events,
    );

    const broken = parseSseText((await post(instance)).text);
    expect(broken.some((item) => item.event === "response.output_text.delta")).toBe(true);
    expect(broken.filter((item) => item.event === "response.failed")).toHaveLength(1);
    expect(broken.at(-1)!.data["response"]).toMatchObject({
      status: "failed",
      error: { code: "upstream_unavailable", message: "first: upstream exploded" },
    });
    expect(events.find((event) => event.type === "failure")).toMatchObject({
      committed: true,
      failure: { provider: "first", kind: "server" },
    });
    expect(events.some((event) => event.type === "completed")).toBe(false);
    expect(instance.usage().providers.find((item) => item.provider === "first")).toMatchObject({
      requests: 0,
      failures: 1,
    });

    expect((await post(instance)).text).toContain("from the fallback");
    expect(failing.requests).toHaveLength(1);

    const refusing = await partial("invalid_prompt", "The prompt was refused.");
    const single = await gateway([
      provider({ name: "only", wireApi: "responses", baseUrl: refusing.baseUrl }),
    ]);
    expect(parseSseText((await post(single)).text).at(-1)!.data["response"]).toMatchObject({
      error: { code: "invalid_prompt", message: "only: The prompt was refused." },
    });
    expect(single.health()[0]!.coolingUntil).toBe(0);
  });

  it("moves on from an endpoint that reports an error but never finishes saying why", async () => {
    const stalled = await upstream((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.write('{"error":{"message":"overloaded');
    });
    const healthy = await upstream(chatAnswer("from the fallback"));
    const events: GatewayEvent[] = [];
    const instance = await gateway(
      [
        provider({ name: "first", baseUrl: stalled.baseUrl, firstByteTimeoutMs: 250 }),
        provider({ name: "second", baseUrl: healthy.baseUrl }),
      ],
      events,
    );
    const started = Date.now();
    expect((await post(instance)).text).toContain("from the fallback");
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(events.find((event) => event.type === "failure")).toMatchObject({
      failure: { provider: "first", kind: "server", status: 503 },
    });
  });

  it("abandons a non-streaming answer that stalls partway", async () => {
    const stalled = await upstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"id":"c1","choices":[');
    });
    const healthy = await upstream(chatAnswer("from the fallback"));
    const events: GatewayEvent[] = [];
    const instance = await startGateway({
      providers: [
        provider({ name: "first", baseUrl: stalled.baseUrl }),
        provider({ name: "second", baseUrl: healthy.baseUrl }),
      ],
      idleTimeoutMs: 250,
      observer: (event) => events.push(event),
    });
    cleanup.push(() => instance.close());
    expect((await post(instance)).text).toContain("from the fallback");
    expect(events.find((event) => event.type === "failure")).toMatchObject({
      failure: {
        provider: "first",
        kind: "timeout",
        message: "The response stalled and was abandoned.",
      },
    });
  });

  it("reads a failure sent as an SSE error event", async () => {
    const failing = await upstream((_request, response) =>
      sendSse(response, [["error", { message: "The model is overloaded.", code: "overloaded" }]]),
    );
    const healthy = await upstream(chatAnswer("from the fallback"));
    const events: GatewayEvent[] = [];
    const instance = await gateway(
      [
        provider({ name: "first", baseUrl: failing.baseUrl }),
        provider({ name: "second", baseUrl: healthy.baseUrl }),
      ],
      events,
    );
    expect((await post(instance)).text).toContain("from the fallback");
    expect(events.find((event) => event.type === "failure")).toMatchObject({
      failure: { provider: "first", kind: "server", message: "The model is overloaded." },
    });
  });

  it("ends a stream that breaks midway with a retryable failure", async () => {
    const dying = await upstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify(chatChunk({ content: "partial" }))}\n\n`);
      setTimeout(() => response.destroy(), 50);
    });
    const events: GatewayEvent[] = [];
    const instance = await gateway([provider({ baseUrl: dying.baseUrl })], events);
    const parsed = parseSseText((await post(instance)).text);
    expect(parsed.some((item) => item.event === "response.output_text.delta")).toBe(true);
    const last = parsed.at(-1)!;
    expect(last.event).toBe("response.failed");
    expect((last.data["response"] as { error: { code: string } }).error.code).toBe(
      "upstream_unavailable",
    );
    expect(events.find((event) => event.type === "failure")).toMatchObject({ committed: true });
  });

  it("tells Codex to compact when every provider reports the context is too long", async () => {
    const tooLong = await upstream((_request, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "This model's maximum context length is 8192 tokens.",
            code: "context_length_exceeded",
          },
        }),
      );
    });
    const instance = await gateway([provider({ baseUrl: tooLong.baseUrl })]);
    const result = await post(instance);
    expect(result.status).toBe(200);
    const last = parseSseText(result.text).at(-1)!;
    expect((last.data["response"] as { error: { code: string } }).error.code).toBe(
      "context_length_exceeded",
    );
    expect(instance.health()[0]!.coolingUntil).toBe(0);
  });

  it("reports rate limits with a retry hint and credentials problems as plain HTTP errors", async () => {
    const limited = await upstream((_request, response) => {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
      response.end(JSON.stringify({ error: { message: "Too many requests" } }));
    });
    const limitedGateway = await gateway([provider({ baseUrl: limited.baseUrl })]);
    const rate = parseSseText((await post(limitedGateway)).text).at(-1)!;
    const error = (rate.data["response"] as { error: { code: string; message: string } }).error;
    expect(error.code).toBe("rate_limit_exceeded");
    expect(error.message).toMatch(/try again in \d+s\./u);

    const denied = await upstream((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "bad key sk-secret-value" } }));
    });
    const deniedGateway = await gateway([
      provider({ baseUrl: denied.baseUrl, apiKey: "sk-secret-value" }),
    ]);
    const auth = await post(deniedGateway);
    expect(auth.status).toBe(401);
    expect(JSON.parse(auth.text)).toMatchObject({ error: { code: "invalid_api_key" } });
  });

  it("treats an empty chat answer as a failure so the turn is retried", async () => {
    const empty = await upstream((_request, response) =>
      sendSse(
        response,
        [
          [undefined, chatChunk({ role: "assistant" })],
          [undefined, chatChunk({}, "stop")],
        ],
        true,
      ),
    );
    const instance = await gateway([provider({ baseUrl: empty.baseUrl })]);
    const last = parseSseText((await post(instance)).text).at(-1)!;
    expect(last.event).toBe("response.failed");
  });

  it("falls back when a Responses endpoint completes without any output", async () => {
    const empty = await upstream((_request, response) =>
      sendSse(response, [
        [
          "response.created",
          { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
        ],
        [
          "response.completed",
          {
            type: "response.completed",
            response: { id: "resp_1", status: "completed", output: [], usage: null },
          },
        ],
      ]),
    );
    const working = await upstream(chatAnswer("from the fallback"));
    const events: GatewayEvent[] = [];
    const instance = await gateway(
      [
        provider({ name: "first", wireApi: "responses", baseUrl: empty.baseUrl }),
        provider({ name: "second", baseUrl: working.baseUrl }),
      ],
      events,
    );
    const text = (await post(instance)).text;
    expect(text).toContain("from the fallback");
    // The whole ID, quoted: the gateway's own IDs are random and may start with resp_1.
    expect(text).not.toContain('"resp_1"');
    expect(events.find((event) => event.type === "failure")).toMatchObject({
      failure: { provider: "first", kind: "protocol" },
    });
  });

  it("answers a non-streaming chat endpoint", async () => {
    const plain = await upstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "c1",
          model: "m",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "whole answer" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      );
    });
    const instance = await gateway([provider({ baseUrl: plain.baseUrl })]);
    const parsed = parseSseText((await post(instance)).text);
    expect(parsed.at(-1)!.event).toBe("response.completed");
    expect(JSON.stringify(parsed)).toContain("whole answer");
  });
});

describe("ProviderChain", () => {
  it("orders healthy providers first, then cooling ones by soonest recovery", async () => {
    let now = 1_000;
    const chain = new ProviderChain({
      providers: [provider({ name: "a" }), provider({ name: "b" }), provider({ name: "c" })],
      cooldownMs: 10_000,
      idleTimeoutMs: 1_000,
      now: () => now,
      attempt: async ({ provider: current }) => {
        if (current.name === "c")
          return {
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              outputTokens: 1,
              reasoningTokens: 0,
              totalTokens: 2,
              estimated: false,
            },
            model: current.model,
            outputTypes: [],
            continued: false,
          };
        const { UpstreamError } = await import("../../src/gateway/types.js");
        throw new UpstreamError({
          provider: current.name,
          kind: current.name === "a" ? "auth" : "server",
          status: 500,
          code: undefined,
          message: "down",
          retryAfterMs: undefined,
        });
      },
    });
    const { Relay } = await import("../../src/gateway/relay.js");
    const sink = {
      writeHead: () => sink,
      write: () => true,
      end: () => sink,
      headersSent: false,
    } as unknown as import("node:http").ServerResponse;
    await chain.handle(
      { input: "x" },
      10,
      { sessionId: "s", threadId: undefined, clientRequestId: undefined },
      new Relay(sink),
      new AbortController().signal,
    );
    expect(chain.candidates().map((item) => item.name)).toEqual(["c", "b", "a"]);
    now += 11_000;
    expect(chain.candidates().map((item) => item.name)).toEqual(["b", "c", "a"]);
  });
});
