import type { ServerResponse } from "node:http";

import { formatSse } from "./sse.js";
import type { UpstreamFailure } from "./types.js";

const PREAMBLE_EVENTS = new Set(["response.created", "response.in_progress"]);

export class Relay {
  readonly #response: ServerResponse;
  #buffer: string[] = [];
  #committed = false;
  #ended = false;

  constructor(response: ServerResponse) {
    this.#response = response;
  }

  get committed(): boolean {
    return this.#committed;
  }

  write(event: string, data: Record<string, unknown>): void {
    if (this.#ended) return;
    const frame = formatSse(event, data);
    if (!this.#committed) {
      if (PREAMBLE_EVENTS.has(event)) {
        this.#buffer.push(frame);
        return;
      }
      this.#commit();
    }
    this.#response.write(frame);
  }

  reset(): void {
    if (!this.#committed) this.#buffer = [];
  }

  end(): void {
    if (this.#ended) return;
    if (!this.#committed) this.#commit();
    this.#ended = true;
    this.#response.end();
  }

  fail(code: string, message: string): void {
    if (this.#ended) return;
    if (!this.#committed) {
      this.#buffer = [];
      this.#commit();
    }
    this.#response.write(
      formatSse("response.failed", {
        type: "response.failed",
        response: { id: null, object: "response", status: "failed", error: { code, message } },
      }),
    );
    this.#ended = true;
    this.#response.end();
  }

  reject(status: number, code: string, message: string, type = "invalid_request_error"): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#committed || this.#response.headersSent) {
      this.#response.end();
      return;
    }
    const body = JSON.stringify({ error: { message, type, code } });
    this.#response.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    this.#response.end(body);
  }

  #commit(): void {
    this.#committed = true;
    this.#response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    for (const frame of this.#buffer) this.#response.write(frame);
    this.#buffer = [];
  }
}

export function streamErrorCode(failure: UpstreamFailure): string | null {
  switch (failure.kind) {
    case "context_length":
      return "context_length_exceeded";
    case "quota":
      return "insufficient_quota";
    case "rate_limit":
      return "rate_limit_exceeded";
    case "server":
    case "network":
    case "timeout":
    case "protocol":
      return "upstream_unavailable";
    default:
      return null;
  }
}
