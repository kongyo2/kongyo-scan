import { type Dispatcher, EnvHttpProxyAgent, fetch, type Response } from "undici";

import { userAgent } from "../version.js";
import { classifyHttpFailure, classifyTransportFailure, protocolFailure } from "./failure.js";
import { type ResolvedProvider, UpstreamError } from "./types.js";

let sharedDispatcher: Dispatcher | undefined;

/**
 * One connection pool for every endpoint. It honors HTTPS_PROXY, HTTP_PROXY, and
 * NO_PROXY; the gateway's own timers replace undici's so long reasoning pauses survive.
 */
export function upstreamDispatcher(): Dispatcher {
  sharedDispatcher ??= new EnvHttpProxyAgent({
    headersTimeout: 0,
    bodyTimeout: 0,
    connect: { timeout: 30_000 },
    keepAliveTimeout: 30_000,
  });
  return sharedDispatcher;
}

export async function closeUpstreamDispatcher(): Promise<void> {
  const dispatcher = sharedDispatcher;
  sharedDispatcher = undefined;
  if (dispatcher) await dispatcher.close().catch(() => undefined);
}

/** Identifiers Codex attaches to a request, used for routing and prompt caching upstream. */
export interface RequestMeta {
  sessionId: string;
  threadId: string | undefined;
  clientRequestId: string | undefined;
}

export function endpointUrl(provider: ResolvedProvider, path: string): string {
  const url = new URL(`${provider.baseUrl}${path}`);
  for (const [name, value] of Object.entries(provider.queryParams))
    url.searchParams.set(name, value);
  return url.toString();
}

/** Headers for one upstream request. Configured headers win over the defaults. */
export function buildHeaders(
  provider: ResolvedProvider,
  meta: RequestMeta,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "user-agent": userAgent(),
    // Codex's own session header, which several gateways use for routing and caching.
    "session-id": meta.sessionId,
  };
  if (meta.threadId !== undefined) headers["thread-id"] = meta.threadId;
  if (meta.clientRequestId !== undefined) headers["x-client-request-id"] = meta.clientRequestId;

  let keyPlaced = false;
  for (const [name, template] of Object.entries(provider.headers)) {
    if (template.includes("{api_key}")) {
      if (provider.apiKey === undefined) continue;
      keyPlaced = true;
    }
    const value = template
      .replaceAll("{session_id}", meta.sessionId)
      .replaceAll("{api_key}", provider.apiKey ?? "");
    headers[name.toLowerCase()] = value;
    if (name.toLowerCase() === "authorization") keyPlaced = true;
  }
  if (!keyPlaced && provider.apiKey !== undefined)
    headers["authorization"] = `Bearer ${provider.apiKey}`;
  return headers;
}

export interface UpstreamResponse {
  response: Response;
  /** Stop the request and release its connection. */
  abort(): void;
  /** True when this request was stopped by its own timer rather than by the caller. */
  timedOut(): boolean;
  /** Iterate the body, failing when no bytes arrive for `idleTimeoutMs`. */
  body(idleTimeoutMs: number): AsyncGenerator<Uint8Array, void, undefined>;
}

/**
 * POST a JSON body and return once response headers arrive. A non-2xx answer,
 * a transport failure, and a first-byte timeout all throw `UpstreamError`.
 */
export async function postUpstream(
  provider: ResolvedProvider,
  path: string,
  body: unknown,
  meta: RequestMeta,
  signal: AbortSignal,
): Promise<UpstreamResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => controller.abort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("first byte timeout"));
  }, provider.firstByteTimeoutMs);

  const release = (): void => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  };

  let response: Response;
  try {
    response = await fetch(endpointUrl(provider, path), {
      method: "POST",
      headers: buildHeaders(provider, meta),
      body: JSON.stringify(body),
      signal: controller.signal,
      dispatcher: upstreamDispatcher(),
    });
  } catch (error) {
    release();
    if (signal.aborted) throw error;
    throw new UpstreamError(classifyTransportFailure(provider.name, error, timedOut), error);
  }
  clearTimeout(timer);

  if (!response.ok) {
    const text = await readText(response, 64 * 1024).catch(() => "");
    release();
    controller.abort();
    throw new UpstreamError(
      classifyHttpFailure(
        provider.name,
        response.status,
        text,
        response.headers.get("retry-after"),
      ),
    );
  }

  return {
    response,
    abort() {
      release();
      controller.abort();
    },
    timedOut: () => timedOut,
    async *body(idleTimeoutMs: number) {
      const stream = response.body;
      if (stream === null) {
        release();
        throw new UpstreamError(
          protocolFailure(provider.name, "The endpoint returned an empty body."),
        );
      }
      let idle: NodeJS.Timeout | undefined;
      const arm = (): void => {
        clearTimeout(idle);
        idle = setTimeout(() => {
          timedOut = true;
          controller.abort(new Error("stream idle timeout"));
        }, idleTimeoutMs);
      };
      try {
        arm();
        for await (const chunk of stream) {
          arm();
          yield chunk;
        }
      } catch (error) {
        if (signal.aborted) throw error;
        const failure = classifyTransportFailure(provider.name, error, timedOut);
        if (timedOut) failure.message = "The response stalled and was abandoned.";
        throw new UpstreamError(failure, error);
      } finally {
        clearTimeout(idle);
        release();
      }
    },
  };
}

/** Read at most `limit` bytes of a response as text. */
export async function readText(response: Response, limit: number): Promise<string> {
  if (response.body === null) return "";
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    text += decoder.decode(chunk, { stream: true });
    if (size >= limit) break;
  }
  return text + decoder.decode();
}
