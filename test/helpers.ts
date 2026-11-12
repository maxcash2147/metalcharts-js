import { MetalCharts, type MetalChartsOptions } from "../src/index.js";

export const FAKE_KEY = "mc_live_test_not_a_real_key";

export interface Call {
  url: URL;
  headers: Headers;
  signal: AbortSignal | undefined;
}

type Handler = (call: Call, index: number) => Response | Promise<Response>;

/** A client whose fetch is answered by `handler`, with no real waiting between retries. */
export function mockClient(handler: Handler, options: MetalChartsOptions = {}) {
  const calls: Call[] = [];
  const waits: number[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof globalThis.fetch;
  const client = new MetalCharts({ apiKey: FAKE_KEY, fetch, ...options });
  client.sleep = async (ms: number) => {
    waits.push(ms);
  };
  return { client, calls, waits };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** An event-stream response delivering `chunks` one at a time. */
export function sse(chunks: (string | Uint8Array)[], onCancel?: () => void): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[i++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export const XAU = {
  symbol: "XAU",
  price: 2650.5,
  exchange: "SPOT",
  marketType: "spot",
  timestamp: "2026-11-12T10:00:00Z",
};
export const XAG = { ...XAU, symbol: "XAG", price: 31.2 };

export function snapshot(...quotes: { symbol: string }[]): string {
  const data = Object.fromEntries(quotes.map((q) => [q.symbol, q]));
  return `event: snapshot\ndata: ${JSON.stringify({ data, timestamp: "2026-11-12T10:00:00Z" })}\n\n`;
}

export function price(quote: object): string {
  return `event: price\ndata: ${JSON.stringify(quote)}\n\n`;
}
