import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import type { ResolvedProvider } from "../src/gateway/types.js";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const BIN_PATH = fileURLToPath(new URL("../bin/kongyo-scan.mjs", import.meta.url));

export function provider(overrides: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    name: "primary",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "test-model",
    wireApi: "chat",
    apiKey: "test-key",
    apiKeySource: "stored key",
    headers: {},
    queryParams: {},
    reasoningEffort: undefined,
    contextWindow: undefined,
    maxOutputTokens: undefined,
    firstByteTimeoutMs: 5_000,
    pricing: undefined,
    compat: { nativeResponses: false, images: true, omitParams: [], extraBody: {} },
    ...overrides,
  };
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

export interface FakeUpstream {
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export async function fakeUpstream(
  handler: (request: RecordedRequest, response: ServerResponse) => void | Promise<void>,
): Promise<FakeUpstream> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const recorded: RecordedRequest = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
      };
      requests.push(recorded);
      void handler(recorded, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export function sendSse(
  response: ServerResponse,
  events: readonly (readonly [string | undefined, unknown])[],
  done = false,
): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [event, data] of events) {
    response.write(
      `${event === undefined ? "" : `event: ${event}\n`}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
    );
  }
  if (done) response.write("data: [DONE]\n\n");
  response.end();
}

export function chatChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    model: "upstream-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export interface ParsedEvent {
  event: string;
  data: Record<string, unknown>;
}

export function parseSseText(text: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
    if (event !== undefined && data !== undefined)
      events.push({ event, data: JSON.parse(data) as Record<string, unknown> });
  }
  return events;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCli(
  args: readonly string[],
  options: { home: string; env?: Record<string, string>; cwd?: string; stdin?: string } = {
    home: "",
  },
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      KONGYO_SCAN_HOME: options.home,
      NO_COLOR: "",
      ...options.env,
    };
    for (const name of [
      "CI",
      "AI_AGENT",
      "CLAUDECODE",
      "FORCE_COLOR",
      "KONGYO_SCAN_CONFIG",
      "KONGYO_SCAN_BASE_URL",
      "KONGYO_SCAN_MODEL",
      "KONGYO_SCAN_API_KEY",
    ]) {
      if (options.env?.[name] === undefined) delete env[name];
    }
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      env,
      cwd: options.cwd ?? ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(options.stdin ?? "");
  });
}
