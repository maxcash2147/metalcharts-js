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
export declare class SSEDecoder {
    lastEventId: string | undefined;
    private event;
    private data;
    private retry;
    constructor(lastEventId?: string);
    /** Feed one line (without its line ending). Returns an event on a blank line. */
    decode(line: string): ServerSentEvent | undefined;
}
/** Split text chunks into lines, holding back a trailing CR in case LF follows. */
export declare class LineSplitter {
    private buffer;
    push(text: string): string[];
    /** Call at end of stream. A bare CR at the very end still ends its line. */
    end(): string[];
}
/** Read a byte stream as lines. `onChunk` runs for every chunk received. */
export declare function readLines(body: ReadableStream<Uint8Array>, onChunk?: () => void): AsyncGenerator<string, void, undefined>;
