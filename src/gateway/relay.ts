import type { ServerResponse } from "node:http";

import { formatSse } from "./sse.js";
import type { UpstreamFailure } from "./types.js";

/** Events that carry no model output yet. They are held back so a failing provider can be swapped out unseen. */
const PREAMBLE_EVENTS = new Set(["response.created", "response.in_progress"]);

/**
 * Writes Responses API events to Codex. Nothing reaches the client until the
 * first event with real output, so an attempt that fails early leaves no trace
 * and the next provider can answer the same request.
 */
export class Relay {
  readonly #response: ServerResponse;
  #buffer: string[] = [];
  #committed = false;
  #ended = false;

  constructor(response: ServerResponse) {
    this.#response = response;
  }

  /** True once output from the current attempt has been sent to the client. */
  get committed(): boolean {
    return this.#committed;
  }

  get ended(): boolean {
    return this.#ended;
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

  /** Forget events buffered by an attempt that failed before producing output. */
  reset(): void {
    if (!this.#committed) this.#buffer = [];
  }

  /** Finish a successful stream. */
  end(): void {
    if (this.#ended) return;
    if (!this.#committed) this.#commit();
    this.#ended = true;
    this.#response.end();
  }

  /**
   * Report a failure as a stream event. Codex retries the request on most codes,
   * compacts on `context_length_exceeded`, and stops on quota errors.
   */
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

  /** Answer with a plain HTTP error, for failures Codex should not retry. */
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

/** The stream error code Codex should see for a failure, or null when a plain HTTP error fits better. */
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
