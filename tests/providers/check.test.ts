import type { ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { closeUpstreamDispatcher } from "../../src/gateway/upstream.js";
import { checkProvider, detectWireApi, listModels } from "../../src/providers/check.js";
import {
  chatChunk,
  type FakeUpstream,
  fakeUpstream,
  provider,
  type RecordedRequest,
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

/** An endpoint that answers the probe with a tool call on both APIs. */
function bothApis(request: RecordedRequest, response: ServerResponse): void {
  if (request.url === "/v1/chat/completions") {
    const tools = request.body["tools"] as { function: { name: string } }[];
    sendSse(
      response,
      [
        [
          undefined,
          chatChunk({
            tool_calls: [
              {
                index: 0,
                id: "call_chat_1",
                function: { name: tools[0]!.function.name, arguments: '{"status":"ok"}' },
              },
            ],
          }),
        ],
        [undefined, chatChunk({}, "tool_calls")],
      ],
      true,
    );
    return;
  }
  sendSse(response, [
    [
      "response.output_item.done",
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_1",
          name: "report_status",
          arguments: '{"status":"ok"}',
          call_id: "call_responses_1",
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
  ]);
}

describe("detectWireApi", () => {
  it("picks Chat Completions on a compatible endpoint that speaks both, Responses on OpenAI's own", async () => {
    const server = await upstream(bothApis);
    const compatible = await detectWireApi(provider({ baseUrl: server.baseUrl }));
    expect(compatible.wireApi).toBe("chat");
    expect(compatible.results.map((result) => result.toolCall)).toEqual([true, true]);

    const native = await detectWireApi(
      provider({
        baseUrl: server.baseUrl,
        compat: { nativeResponses: true, images: true, omitParams: [], extraBody: {} },
      }),
    );
    expect(native.wireApi).toBe("responses");
  });

  it("picks the only API that answers, and none when neither does", async () => {
    const responsesOnly = await upstream((request, response) => {
      if (request.url === "/v1/responses") return bothApis(request, response);
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Not found." } }));
    });
    expect((await detectWireApi(provider({ baseUrl: responsesOnly.baseUrl }))).wireApi).toBe(
      "responses",
    );

    const neither = await upstream((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Invalid API key." } }));
    });
    const detected = await detectWireApi(provider({ baseUrl: neither.baseUrl }));
    expect(detected.wireApi).toBeUndefined();
    expect(detected.results.every((result) => result.failure?.kind === "auth")).toBe(true);
  });
});

describe("checkProvider", () => {
  it("sends the requested effort and reports an answer without a tool call", async () => {
    const chatty = await upstream((_request, response) =>
      sendSse(
        response,
        [
          [undefined, chatChunk({ content: "ok" })],
          [undefined, chatChunk({}, "stop")],
        ],
        true,
      ),
    );
    const result = await checkProvider(provider({ baseUrl: chatty.baseUrl }), { effort: "max" });
    expect(result).toMatchObject({ ok: true, toolCall: false, wireApi: "chat" });
    expect(chatty.requests[0]!.body["reasoning_effort"]).toBe("max");
  });
});

describe("listModels", () => {
  it("lists text models once, sorted, whatever shape the endpoint uses", async () => {
    const server = await upstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: [
            { id: "zeta", endpoints: ["chat/completions", "responses"] },
            { id: "painter", endpoints: ["images/generations"] },
            { id: "alpha" },
            { id: "zeta" },
            "plain-id",
          ],
        }),
      );
    });
    const listing = await listModels(provider({ baseUrl: server.baseUrl }));
    expect(listing).toMatchObject({ ok: true, models: ["alpha", "plain-id", "zeta"] });
    expect(server.requests[0]!.headers["authorization"]).toBe("Bearer test-key");
  });

  it("reports why a list is unavailable", async () => {
    const denied = await upstream((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Invalid API key." } }));
    });
    const listing = await listModels(provider({ baseUrl: denied.baseUrl }));
    expect(listing.ok).toBe(false);
    expect(listing.failure).toMatchObject({ kind: "auth", status: 401 });
  });
});
