import { afterEach, describe, expect, it } from "vitest";

import { startGateway } from "../../src/gateway/server.js";
import { isInterimOutput, TurnGuard } from "../../src/gateway/turn-guard.js";
import { closeUpstreamDispatcher } from "../../src/gateway/upstream.js";
import { chatChunk, fakeUpstream, parseSseText, provider, sendSse } from "../helpers.js";

const message = (text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
  ...extra,
});
const MARKER =
  'CODEX_SECURITY_SCAN_PROGRESS {"phase":"discovery","filesCompleted":0,"filesTotal":2}';

describe("isInterimOutput", () => {
  it("recognizes answers that are only progress markers", () => {
    expect(isInterimOutput([message(`${MARKER}\n`)])).toBe(true);
    expect(
      isInterimOutput([
        { type: "reasoning", summary: [] },
        message(
          `\n${MARKER}\n\nCODEX_SECURITY_WORKER_STATUS {"phase":"file_review","planned":2,"started":1}`,
        ),
      ]),
    ).toBe(true);
  });

  it("treats commentary-only messages and reasoning-only answers as interim", () => {
    expect(
      isInterimOutput([message("Mapping the entry points next.", { phase: "commentary" })]),
    ).toBe(true);
    expect(isInterimOutput([{ type: "reasoning", summary: [] }])).toBe(true);
  });

  it("leaves real answers and tool calls alone", () => {
    expect(isInterimOutput([message("The scan is complete. Three findings were recorded.")])).toBe(
      false,
    );
    expect(isInterimOutput([message(`${MARKER}\nAll done.`)])).toBe(false);
    expect(
      isInterimOutput([
        message(MARKER),
        { type: "function_call", name: "exec_command", arguments: "{}", call_id: "c" },
      ]),
    ).toBe(false);
    expect(isInterimOutput([message("Wrapping up.", { phase: "final_answer" })])).toBe(false);
    expect(isInterimOutput([])).toBe(false);
  });
});

describe("TurnGuard", () => {
  it("keeps a turn open a bounded number of times in a row per conversation", () => {
    const guard = new TurnGuard(2);
    const interim = [message(MARKER)];
    expect(guard.shouldContinue("thread-a", interim)).toBe(true);
    expect(guard.shouldContinue("thread-a", interim)).toBe(true);
    expect(guard.shouldContinue("thread-a", interim)).toBe(false);
    // Another conversation has its own budget, and real work resets the count.
    expect(guard.shouldContinue("thread-b", interim)).toBe(true);
    expect(
      guard.shouldContinue("thread-a", [
        { type: "function_call", name: "f", arguments: "{}", call_id: "c" },
      ]),
    ).toBe(false);
    expect(guard.shouldContinue("thread-a", interim)).toBe(true);
  });
});

describe("gateway turn guard", () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()));
    await closeUpstreamDispatcher();
  });

  async function completedResponse(
    handler: Parameters<typeof fakeUpstream>[0],
    wireApi: "chat" | "responses",
  ): Promise<Record<string, unknown>> {
    const upstream = await fakeUpstream(handler);
    cleanup.push(() => upstream.close());
    const gateway = await startGateway({
      providers: [provider({ wireApi, baseUrl: upstream.baseUrl })],
    });
    cleanup.push(() => gateway.close());
    const response = await fetch(`${gateway.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gateway.token}`,
        "content-type": "application/json",
        "thread-id": "thread-1",
      },
      body: JSON.stringify({ input: "scan" }),
    });
    const completed = parseSseText(await response.text()).find(
      (event) => event.event === "response.completed",
    );
    return completed!.data["response"] as Record<string, unknown>;
  }

  it("marks a marker-only chat answer as not ending the turn", async () => {
    const response = await completedResponse(
      (_request, reply) =>
        sendSse(
          reply,
          [
            [undefined, chatChunk({ content: `${MARKER}\n` })],
            [undefined, chatChunk({}, "stop")],
          ],
          true,
        ),
      "chat",
    );
    expect(response["end_turn"]).toBe(false);
  });

  it("marks a marker-only Responses answer as not ending the turn", async () => {
    const response = await completedResponse(
      (_request, reply) =>
        sendSse(reply, [
          [
            "response.output_item.done",
            { type: "response.output_item.done", output_index: 0, item: message(MARKER) },
          ],
          [
            "response.completed",
            {
              type: "response.completed",
              response: {
                id: "resp_1",
                status: "completed",
                output: [],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ],
        ]),
      "responses",
    );
    expect(response["end_turn"]).toBe(false);
  });

  it("leaves a real final answer untouched", async () => {
    const response = await completedResponse(
      (_request, reply) =>
        sendSse(
          reply,
          [
            [undefined, chatChunk({ content: "The scan is complete." })],
            [undefined, chatChunk({}, "stop")],
          ],
          true,
        ),
      "chat",
    );
    expect(response).not.toHaveProperty("end_turn");
  });
});
