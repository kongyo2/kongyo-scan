import { randomUUID } from "node:crypto";

import { fetch } from "undici";

import type { WireApi } from "../config/schema.js";
import { describeError } from "../core/errors.js";
import { type AttemptSink, runAttempt } from "../gateway/attempts.js";
import type { ResponsesRequest } from "../gateway/chat-request.js";
import { classifyHttpFailure, classifyTransportFailure } from "../gateway/failure.js";
import { isRecord } from "../gateway/tools.js";
import {
  type ResolvedProvider,
  type TokenUsage,
  UpstreamError,
  type UpstreamFailure,
} from "../gateway/types.js";
import { buildHeaders, endpointUrl, upstreamDispatcher } from "../gateway/upstream.js";

export interface CheckResult {
  provider: string;
  model: string;
  wireApi: WireApi;
  ok: boolean;
  toolCall: boolean;
  reasoning: boolean;
  latencyMs: number;
  usage: TokenUsage | undefined;
  failure: UpstreamFailure | undefined;
}

const PROBE_TOOL = "report_status";

function probeRequest(effort: string | undefined): ResponsesRequest {
  return {
    model: "probe",
    stream: true,
    store: false,
    input: [
      {
        type: "message",
        role: "developer",
        content: [
          {
            type: "input_text",
            text: "You are a connectivity probe. Follow the instruction exactly.",
          },
        ],
      },
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Call the ${PROBE_TOOL} tool once with status set to "ok". Do not answer in text.`,
          },
        ],
      },
    ],
    tools: [
      {
        type: "namespace",
        name: "kongyo_scan",
        description: "Connectivity probe tools.",
        tools: [
          {
            type: "function",
            name: PROBE_TOOL,
            description: "Report the probe status.",
            strict: false,
            parameters: {
              type: "object",
              properties: { status: { type: "string", description: 'Always "ok".' } },
              required: ["status"],
            },
          },
        ],
      },
    ],
    tool_choice: "auto",
    parallel_tool_calls: true,
    ...(effort === undefined ? {} : { reasoning: { effort } }),
  };
}

class CollectingSink implements AttemptSink {
  readonly events: { event: string; data: Record<string, unknown> }[] = [];
  readonly committed = false;

  write(event: string, data: Record<string, unknown>): void {
    this.events.push({ event, data });
  }
}

export interface CheckOptions {
  effort?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export async function checkProvider(
  provider: ResolvedProvider,
  options: CheckOptions = {},
): Promise<CheckResult> {
  const started = Date.now();
  const sink = new CollectingSink();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("probe timeout")),
    options.timeoutMs ?? 120_000,
  );
  const onAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const request = probeRequest(options.effort);
  const base = {
    provider: provider.name,
    model: provider.model,
    wireApi: provider.wireApi,
  };
  try {
    const result = await runAttempt({
      provider,
      request,
      requestCharacters: JSON.stringify(request).length,
      meta: { sessionId: randomUUID(), threadId: undefined, clientRequestId: undefined },
      relay: sink,
      signal: controller.signal,
      idleTimeoutMs: options.timeoutMs ?? 120_000,
    });
    let toolCall = false;
    let reasoning = false;
    for (const { event, data } of sink.events) {
      if (event !== "response.output_item.done" || !isRecord(data["item"])) continue;
      const item = data["item"];
      if (item["type"] === "function_call" && item["name"] === PROBE_TOOL) toolCall = true;
      if (item["type"] === "reasoning") reasoning = true;
    }
    return {
      ...base,
      ok: true,
      toolCall,
      reasoning,
      latencyMs: Date.now() - started,
      usage: result.usage,
      failure: undefined,
    };
  } catch (error) {
    const failure: UpstreamFailure =
      error instanceof UpstreamError
        ? error.failure
        : {
            provider: provider.name,
            kind: controller.signal.aborted ? "timeout" : "network",
            status: undefined,
            code: undefined,
            message: controller.signal.aborted
              ? "No response before the timeout."
              : describeError(error),
            retryAfterMs: undefined,
          };
    return {
      ...base,
      ok: false,
      toolCall: false,
      reasoning: false,
      latencyMs: Date.now() - started,
      usage: undefined,
      failure,
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export interface ModelListing {
  ok: boolean;
  models: string[];
  failure: UpstreamFailure | undefined;
}

export async function listModels(
  provider: ResolvedProvider,
  signal?: AbortSignal,
): Promise<ModelListing> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("timeout")), 30_000);
  const onAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const headers = buildHeaders(provider, {
      sessionId: randomUUID(),
      threadId: undefined,
      clientRequestId: undefined,
    });
    delete headers["content-type"];
    headers["accept"] = "application/json";
    const response = await fetch(endpointUrl(provider, "/models"), {
      method: "GET",
      headers,
      signal: controller.signal,
      dispatcher: upstreamDispatcher(),
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        models: [],
        failure: classifyHttpFailure(provider.name, response.status, text),
      };
    }
    const parsed = JSON.parse(text) as unknown;
    const entries =
      isRecord(parsed) && Array.isArray(parsed["data"])
        ? parsed["data"]
        : Array.isArray(parsed)
          ? parsed
          : [];
    const models: string[] = [];
    for (const entry of entries) {
      if (typeof entry === "string") models.push(entry);
      else if (isRecord(entry) && typeof entry["id"] === "string") {
        const endpoints = entry["endpoints"];
        if (
          Array.isArray(endpoints) &&
          !endpoints.some((endpoint) => /chat|responses|messages/u.test(String(endpoint)))
        ) {
          continue;
        }
        models.push(entry["id"]);
      }
    }
    return {
      ok: true,
      models: [...new Set(models)].sort((a, b) => a.localeCompare(b)),
      failure: undefined,
    };
  } catch (error) {
    return {
      ok: false,
      models: [],
      failure: classifyTransportFailure(provider.name, error, controller.signal.aborted),
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function detectWireApi(
  provider: ResolvedProvider,
  options: CheckOptions = {},
): Promise<{ wireApi: WireApi | undefined; results: CheckResult[] }> {
  const results = await Promise.all(
    (["chat", "responses"] as const).map((wireApi) =>
      checkProvider({ ...provider, wireApi }, options),
    ),
  );
  const usable = results.filter((result) => result.ok && result.toolCall);
  const answering = results.filter((result) => result.ok);
  return { wireApi: (usable[0] ?? answering[0])?.wireApi, results };
}
