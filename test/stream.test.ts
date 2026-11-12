import { describe, expect, test } from "bun:test";
import { APIConnectionError, MetalChartsError, PlanRequiredError, RateLimitError, type StreamEvent } from "../src/index.js";
import { LineSplitter, SSEDecoder, readLines } from "../src/sse.js";
import { XAG, XAU, json, mockClient, price, snapshot, sse } from "./helpers.js";

async function collect<T>(iter: AsyncIterable<T>, max = Infinity): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) {
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

describe("parser", () => {
  test("splits every line ending, across chunks", () => {
    const splitter = new LineSplitter();
    const lines = [..."a\r|\nb\n|c\rd|\r\n\r|\n".split("|").flatMap((chunk) => splitter.push(chunk)), ...splitter.end()];
    expect(lines).toEqual(["a", "b", "c", "d", ""]);
  });

  test("decodes multibyte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode("data: été\n");
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 7));
        c.enqueue(bytes.slice(7));
        c.close();
      },
    });
    expect(await collect(readLines(body))).toEqual(["data: été"]);
  });

  test("follows the event stream rules", () => {
    const decoder = new SSEDecoder();
    const text =
      ': ping\n\nevent: price\ndata: {"a":\ndata: 1}\nid: 7\nretry: 2500\n\ndata: plain\n\nevent: price\ndata: cut off';
    const events = text
      .split("\n")
      .map((line) => decoder.decode(line))
      .filter((e) => e !== undefined);
    expect(events).toEqual([
      { event: "price", data: '{"a":\n1}', id: "7", retry: 2500 },
      { event: "message", data: "plain", id: "7", retry: undefined },
    ]);
  });
});

describe("streamPrices", () => {
  test("yields snapshot then price, skipping heartbeats and unknown events", async () => {
    const { client, calls } = mockClient(() =>
      sse([snapshot(XAU, XAG), ": ping\n\n", 'event: status\ndata: {"note":"later"}\n\n', price({ ...XAU, price: 2651 })]),
    );
    const events = await collect(client.streamPrices({ symbols: ["XAU", "XAG"], currency: "EUR", reconnect: false }));

    expect(events.map((e) => e.type)).toEqual(["snapshot", "price"]);
    expect(Object.keys(events[0]!.quotes).sort()).toEqual(["XAG", "XAU"]);
    const second = events[1]!;
    if (second.type !== "price") throw new Error("expected a price event");
    expect(second.data.price).toBe(2651);
    expect(second.quotes).toEqual({ XAU: { ...XAU, price: 2651 } });

    const call = calls[0]!;
    expect(call.url.pathname).toBe("/v1/stream/prices");
    expect(Object.fromEntries(call.url.searchParams)).toEqual({ symbols: "XAU,XAG", currency: "EUR" });
    expect(call.headers.get("accept")).toBe("text/event-stream");
    expect(call.headers.get("authorization")).toStartWith("Bearer mc_live_");
  });

  test("Object.assign(latest, event.quotes) keeps a current table", async () => {
    const { client } = mockClient(() => sse([snapshot(XAU, XAG), price({ ...XAG, price: 31.5 })]));
    const latest: Record<string, { price: number }> = {};
    for await (const event of client.streamPrices({ reconnect: false })) Object.assign(latest, event.quotes);
    expect(latest.XAU!.price).toBe(2650.5);
    expect(latest.XAG!.price).toBe(31.5);
  });

  test("an event split into tiny chunks", async () => {
    const text = snapshot(XAU);
    const chunks = text.match(/[\s\S]{1,5}/g)!;
    const { client } = mockClient(() => sse(chunks));
    const [event] = await collect(client.streamPrices({ reconnect: false }));
    expect(event!.quotes.XAU!.price).toBe(2650.5);
  });

  test("reconnects after the server closes, sending Last-Event-ID", async () => {
    const bodies = [[snapshot(XAU), `id: 41\nevent: price\ndata: ${JSON.stringify(XAU)}\n\n`], [snapshot(XAG)]];
    const { client, calls, waits } = mockClient((_c, i) => sse(bodies[i]!));
    const events = await collect(client.streamPrices(), 3);

    expect(events.map((e) => e.type)).toEqual(["snapshot", "price", "snapshot"]);
    expect(events[1]!.id).toBe("41");
    expect(calls.length).toBe(2);
    expect(calls[0]!.headers.get("last-event-id")).toBeNull();
    expect(calls[1]!.headers.get("last-event-id")).toBe("41");
    expect(waits.length).toBe(1);
    expect(waits[0]!).toBeLessThanOrEqual(1000);
  });

  test("breaking out of the loop cancels the response body", async () => {
    let cancelled = false;
    const { client } = mockClient(() =>
      sse([snapshot(XAU), price(XAU), price(XAU), price(XAU)], () => {
        cancelled = true;
      }),
    );
    for await (const event of client.streamPrices()) {
      expect(event.type).toBe("snapshot");
      break;
    }
    expect(cancelled).toBe(true);
  });

  test("aborting the signal ends the loop quietly", async () => {
    const controller = new AbortController();
    const { client } = mockClient(() => sse([snapshot(XAU), price(XAU)]));
    const seen: StreamEvent[] = [];
    for await (const event of client.streamPrices({ signal: controller.signal })) {
      seen.push(event);
      controller.abort();
    }
    expect(seen.length).toBe(1);
  });

  test("plan errors are thrown without retrying", async () => {
    const { client, calls } = mockClient(() =>
      json({ error: "Streaming needs the Pro plan or above.", required_plan: "pro", upgrade_url: "https://metalcharts.org/pricing?tab=api" }, 403),
    );
    const err = await collect(client.streamPrices()).catch((e) => e);
    expect(err).toBeInstanceOf(PlanRequiredError);
    expect(err.requiredPlan).toBe("pro");
    expect(calls.length).toBe(1);
  });

  test("429 on the first connection is thrown", async () => {
    const { client, calls } = mockClient(() => json({ error: "Too many concurrent streams" }, 429, { "retry-after": "5" }));
    const err = await collect(client.streamPrices()).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(calls.length).toBe(1);
  });

  test("429 on a reconnect waits for Retry-After and tries again", async () => {
    const answers = [
      () => sse([snapshot(XAU)]),
      () => json({ error: "Too many concurrent streams" }, 429, { "retry-after": "7" }),
      () => sse([snapshot(XAG)]),
    ];
    const { client, waits } = mockClient((_c, i) => answers[i]!());
    const events = await collect(client.streamPrices(), 2);
    expect(Object.keys(events[1]!.quotes)).toEqual(["XAG"]);
    expect(waits.at(-1)!).toBeGreaterThanOrEqual(7000);
  });

  test("retries network failures and 5xx with growing backoff", async () => {
    const { client, waits } = mockClient((_c, i) => {
      if (i === 0) throw new TypeError("fetch failed");
      if (i === 1) return new Response("Bad Gateway", { status: 502 });
      return sse([snapshot(XAU)]);
    });
    const [event] = await collect(client.streamPrices(), 1);
    expect(event!.type).toBe("snapshot");
    expect(waits.length).toBe(2);
    expect(waits[0]!).toBeLessThanOrEqual(1000);
    expect(waits[1]!).toBeGreaterThanOrEqual(1000);
  });

  test("gives up after maxReconnectAttempts", async () => {
    const { client, calls } = mockClient(() => {
      throw new TypeError("fetch failed");
    });
    const err = await collect(client.streamPrices({ maxReconnectAttempts: 3 })).catch((e) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(calls.length).toBe(4);
  });

  test("without reconnect, connection errors are thrown", async () => {
    const { client, calls } = mockClient(() => {
      throw new TypeError("fetch failed");
    });
    const err = await collect(client.streamPrices({ reconnect: false })).catch((e) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(calls.length).toBe(1);
  });

  test("a JSON answer instead of an event stream is an error", async () => {
    const { client } = mockClient(() => json({ success: true }));
    const err = await collect(client.streamPrices()).catch((e) => e);
    expect(err).toBeInstanceOf(MetalChartsError);
    expect(err.message).toContain("text/event-stream");
  });

  test("the server's retry field sets the backoff base", async () => {
    const { client, waits } = mockClient((_c, i) => sse([i === 0 ? `retry: 100\n${snapshot(XAU)}` : snapshot(XAU)]));
    await collect(client.streamPrices(), 2);
    expect(waits[0]!).toBeLessThanOrEqual(100);
  });
});
