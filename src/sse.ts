/**
 * A small Server-Sent Events parser following the WHATWG event stream rules:
 * lines end in CRLF, LF or CR; a line starting with a colon is a comment (the
 * API's `: ping` heartbeat); a blank line dispatches the event built so far;
 * an event cut off by the end of the stream is dropped.
 */

export interface ServerSentEvent {
  event: string;
  data: string;
  id: string | undefined;
  retry: number | undefined;
}

export class SSEDecoder {
  lastEventId: string | undefined;
  private event = "";
  private data: string[] = [];
  private retry: number | undefined;

  constructor(lastEventId?: string) {
    this.lastEventId = lastEventId;
  }

  /** Feed one line (without its line ending). Returns an event on a blank line. */
  decode(line: string): ServerSentEvent | undefined {
    if (line === "") {
      if (this.data.length === 0) {
        this.event = "";
        this.retry = undefined;
        return undefined;
      }
      const sse: ServerSentEvent = {
        event: this.event || "message",
        data: this.data.join("\n"),
        id: this.lastEventId,
        retry: this.retry,
      };
      this.event = "";
      this.data = [];
      this.retry = undefined;
      return sse;
    }

    if (line.startsWith(":")) return undefined;

    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (name) {
      case "event":
        this.event = value;
        break;
      case "data":
        this.data.push(value);
        break;
      case "id":
        if (!value.includes("\0")) this.lastEventId = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.retry = Number(value);
        break;
    }
    return undefined;
  }
}

const LINE_END = /\r\n|\r|\n/;

/** Split text chunks into lines, holding back a trailing CR in case LF follows. */
export class LineSplitter {
  private buffer = "";

  push(text: string): string[] {
    this.buffer += text;
    let tail = "";
    let head = this.buffer;
    if (head.endsWith("\r")) {
      head = head.slice(0, -1);
      tail = "\r";
    }
    const parts = head.split(LINE_END);
    this.buffer = parts.pop()! + tail;
    return parts;
  }

  /** Call at end of stream. A bare CR at the very end still ends its line. */
  end(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    return rest.endsWith("\r") ? rest.slice(0, -1).split(LINE_END) : [];
  }
}

/** Read a byte stream as lines. `onChunk` runs for every chunk received. */
export async function* readLines(
  body: ReadableStream<Uint8Array>,
  onChunk?: () => void,
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const splitter = new LineSplitter();
  let first = true;
  let done = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      onChunk?.();
      let text = decoder.decode(result.value, { stream: true });
      if (first && text) {
        first = false;
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      }
      yield* splitter.push(text);
    }
    done = true;
    yield* splitter.push(decoder.decode());
    yield* splitter.end();
  } finally {
    if (!done) {
      // The caller stopped early: drop the connection.
      await reader.cancel().catch(() => {});
    }
    try {
      reader.releaseLock();
    } catch {
      // Already released or errored; nothing left to clean up.
    }
  }
}
