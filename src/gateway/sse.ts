/** One server-sent event. `event` is undefined when the stream omits the field. */
export interface SseMessage {
  event: string | undefined;
  data: string;
}

/**
 * Incremental `text/event-stream` parser. Feed it decoded text in any chunking;
 * it yields each event once its terminating blank line arrives.
 */
export class SseParser {
  #buffer = "";
  #event: string | undefined;
  #data: string[] = [];

  push(chunk: string): SseMessage[] {
    this.#buffer += chunk;
    const messages: SseMessage[] = [];
    for (;;) {
      const end = this.#lineEnd();
      if (end === null) break;
      const line = this.#buffer.slice(0, end.index);
      this.#buffer = this.#buffer.slice(end.index + end.length);
      const message = this.#line(line);
      if (message) messages.push(message);
    }
    return messages;
  }

  /** Emit a final event when the stream ended without a trailing blank line. */
  flush(): SseMessage[] {
    const messages: SseMessage[] = [];
    if (this.#buffer !== "") {
      const message = this.#line(this.#buffer);
      this.#buffer = "";
      if (message) messages.push(message);
    }
    const pending = this.#dispatch();
    if (pending) messages.push(pending);
    return messages;
  }

  #lineEnd(): { index: number; length: number } | null {
    const buffer = this.#buffer;
    for (let index = 0; index < buffer.length; index++) {
      const code = buffer.charCodeAt(index);
      if (code === 10) return { index, length: 1 };
      if (code === 13) {
        // A lone CR at the very end may be the first half of CRLF; wait for more.
        if (index === buffer.length - 1) return null;
        return { index, length: buffer.charCodeAt(index + 1) === 10 ? 2 : 1 };
      }
    }
    return null;
  }

  #line(line: string): SseMessage | null {
    if (line === "") return this.#dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.#event = value;
    else if (field === "data") this.#data.push(value);
    return null;
  }

  #dispatch(): SseMessage | null {
    if (this.#data.length === 0) {
      this.#event = undefined;
      return null;
    }
    const message: SseMessage = { event: this.#event, data: this.#data.join("\n") };
    this.#event = undefined;
    this.#data = [];
    return message;
  }
}

/** Serialize one event the way the Responses API streams it. */
export function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Decode a byte stream into SSE messages. */
export async function* readSse(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<SseMessage, void, undefined> {
  const decoder = new TextDecoder("utf-8");
  const parser = new SseParser();
  for await (const chunk of body) {
    yield* parser.push(decoder.decode(chunk, { stream: true }));
  }
  yield* parser.push(decoder.decode());
  yield* parser.flush();
}
