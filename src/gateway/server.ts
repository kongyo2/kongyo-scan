import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { ProviderChain, type ProviderHealth } from "./chain.js";
import type { ResponsesRequest } from "./chat-request.js";
import { Relay } from "./relay.js";
import type { GatewayObserver, ResolvedProvider } from "./types.js";
import type { RequestMeta } from "./upstream.js";
import type { UsageSummary } from "./usage.js";

const MAX_BODY_BYTES = 256 * 1024 * 1024;
const LOOPBACK = "127.0.0.1";

export interface GatewayOptions {
  providers: readonly ResolvedProvider[];
  port?: number;
  cooldownMs?: number;
  idleTimeoutMs?: number;
  observer?: GatewayObserver;
}

export interface Gateway {
  readonly baseUrl: string;
  readonly port: number;
  readonly token: string;
  usage(): UsageSummary;
  health(): ProviderHealth[];
  close(): Promise<void>;
}

export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const token = randomBytes(32).toString("hex");
  const fallbackSession = randomUUID();
  const chain = new ProviderChain({
    providers: options.providers,
    cooldownMs: options.cooldownMs ?? 60_000,
    idleTimeoutMs: options.idleTimeoutMs ?? 300_000,
    ...(options.observer ? { observer: options.observer } : {}),
  });
  const active = new Set<AbortController>();

  const server: Server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      if (!response.headersSent)
        sendJson(response, 500, errorBody("internal_error", String(error)));
      else response.end();
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 30_000;

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    if (request.method === "GET" && (path === "/health" || path === "/healthz")) {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (!authorized(request.headers.authorization, token)) {
      sendJson(
        response,
        401,
        errorBody("invalid_api_key", "kongyo-scan gateway: missing or invalid token."),
      );
      return;
    }
    if (request.method === "GET" && (path === "/v1/models" || path === "/models")) {
      sendJson(response, 200, {
        object: "list",
        data: options.providers.map((provider) => ({
          id: provider.model,
          object: "model",
          owned_by: provider.name,
        })),
      });
      return;
    }
    if (request.method === "POST" && (path === "/v1/responses" || path === "/responses")) {
      await handleResponses(request, response);
      return;
    }
    sendJson(
      response,
      404,
      errorBody("not_found", `kongyo-scan gateway: ${request.method} ${path} is not supported.`),
    );
  }

  async function handleResponses(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let text: string;
    try {
      text = await readBody(request);
    } catch (error) {
      sendJson(
        response,
        413,
        errorBody("request_too_large", error instanceof Error ? error.message : String(error)),
      );
      return;
    }
    let body: ResponsesRequest;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("not an object");
      body = parsed as ResponsesRequest;
    } catch {
      sendJson(
        response,
        400,
        errorBody(
          "invalid_request_error",
          "kongyo-scan gateway: the request body isn't valid JSON.",
        ),
      );
      return;
    }

    const controller = new AbortController();
    active.add(controller);
    response.on("close", () => {
      if (!response.writableFinished) controller.abort(new Error("client disconnected"));
      active.delete(controller);
    });

    const meta: RequestMeta = {
      sessionId:
        header(request, "session-id") ??
        header(request, "session_id") ??
        (typeof body["prompt_cache_key"] === "string" && body["prompt_cache_key"] !== ""
          ? body["prompt_cache_key"]
          : fallbackSession),
      threadId: header(request, "thread-id"),
      clientRequestId: header(request, "x-client-request-id"),
    };
    await chain.handle(body, text.length, meta, new Relay(response), controller.signal);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, LOOPBACK, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://${LOOPBACK}:${port}/v1`,
    port,
    token,
    usage: () => chain.ledger.summary(),
    health: () => chain.health(),
    async close() {
      for (const controller of active) controller.abort(new Error("gateway closed"));
      active.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

function authorized(headerValue: string | undefined, token: string): boolean {
  if (headerValue === undefined) return false;
  const match = /^Bearer\s+(.+)$/iu.exec(headerValue.trim());
  if (!match) return false;
  const presented = Buffer.from(match[1]!, "utf8");
  const expected = Buffer.from(token, "utf8");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first !== undefined && first.trim() !== "" ? first.trim() : undefined;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES)
      throw new Error("kongyo-scan gateway: the request body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function errorBody(code: string, message: string): Record<string, unknown> {
  return { error: { message, type: "invalid_request_error", code } };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}
