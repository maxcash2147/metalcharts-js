import { afterEach, describe, expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import {
  APIConnectionError,
  AuthenticationError,
  MetalCharts,
  MetalChartsError,
  PlanRequiredError,
  RateLimitError,
  VERSION,
} from "../src/index.js";
import { FAKE_KEY, XAU, json, mockClient } from "./helpers.js";

const savedEnv = process.env.METALCHARTS_API_KEY;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.METALCHARTS_API_KEY;
  else process.env.METALCHARTS_API_KEY = savedEnv;
});

describe("setup", () => {
  test("reads the key from METALCHARTS_API_KEY", async () => {
    process.env.METALCHARTS_API_KEY = FAKE_KEY;
    let auth = "";
    const client = new MetalCharts({
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        auth = new Headers(init?.headers).get("authorization") ?? "";
        return json({ success: true, data: {} });
      }) as typeof fetch,
    });
    await client.prices();
    expect(auth).toBe(`Bearer ${FAKE_KEY}`);
  });

  test("throws without a key", () => {
    delete process.env.METALCHARTS_API_KEY;
    expect(() => new MetalCharts({ fetch: (async () => json({})) as unknown as typeof fetch })).toThrow(
      /METALCHARTS_API_KEY/,
    );
  });

  test("the key is not visible on the instance", () => {
    const { client } = mockClient(() => json({}));
    expect(JSON.stringify(client)).not.toContain("not_a_real_key");
    expect(Object.values(client).join(" ")).not.toContain("not_a_real_key");
  });

  test("VERSION matches package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });
});

describe("requests", () => {
  test("prices sends auth and joins symbols", async () => {
    const { client, calls } = mockClient(() => json({ success: true, data: { XAU } }));
    const res = await client.prices({ symbols: ["XAU", "XAG"], currency: "EUR", unit: "g" });

    const call = calls[0]!;
    expect(call.url.pathname).toBe("/v1/prices");
    expect(Object.fromEntries(call.url.searchParams)).toEqual({ symbols: "XAU,XAG", currency: "EUR", unit: "g" });
    expect(call.headers.get("authorization")).toBe(`Bearer ${FAKE_KEY}`);
    expect(call.headers.get("user-agent")).toStartWith("metalcharts-js/");
    expect(res.data.XAU?.price).toBe(2650.5);
  });

  test("prices without params has no query string", async () => {
    const { client, calls } = mockClient(() => json({ success: true, data: {} }));
    await client.prices();
    expect(calls[0]!.url.toString()).toBe("https://api.metalcharts.org/v1/prices");
  });

  test("history encodes the symbol and dates", async () => {
    const { client, calls } = mockClient(() => json({ success: true, data: [] }));
    await client.history("XAU", { interval: "1d", start: new Date("2026-10-01T00:00:00Z"), end: "2026-10-31", karat: 22 });
    await client.history("XAU/../usage");

    expect(calls[0]!.url.pathname).toBe("/v1/history/XAU");
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      interval: "1d",
      start: "2026-10-01",
      end: "2026-10-31",
      karat: "22",
    });
    expect(calls[1]!.url.pathname).toBe("/v1/history/XAU%2F..%2Fusage");
  });

  test("instruments, usage, metals and convert", async () => {
    const { client, calls } = mockClient(() => json({ success: true, data: [] }));
    await client.instruments({ assetClass: "commodity", search: "gold", limit: 5 });
    await client.usage();
    await client.metals();
    await client.convert({ from: "XAU", to: "EUR", amount: 10, unit: "g" });

    expect(calls.map((c) => c.url.pathname)).toEqual(["/v1/instruments", "/v1/usage", "/v1/metals", "/v1/convert"]);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ asset_class: "commodity", search: "gold", limit: "5" });
    expect(Object.fromEntries(calls[3]!.url.searchParams)).toEqual({ from: "XAU", to: "EUR", amount: "10", unit: "g" });
  });

  test("get drops empty values and returns text for CSV", async () => {
    const csv = "timestamp,price\n2026-10-01T00:00:00Z,2650.5\n";
    const { client, calls } = mockClient(() => new Response(csv, { headers: { "content-type": "text/csv" } }));
    const out = await client.get<string>("v1/history/XAU", { format: "csv", range: "1M", type: undefined, x: null, flag: true });
    expect(out).toBe(csv);
    expect(calls[0]!.url.pathname).toBe("/v1/history/XAU");
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ format: "csv", range: "1M", flag: "true" });
  });

  test("get refuses full URLs", async () => {
    const { client } = mockClient(() => json({}));
    expect(client.get("https://example.com/v1/prices")).rejects.toThrow(TypeError);
  });
});

describe("errors", () => {
  test("401 is an AuthenticationError", async () => {
    const { client } = mockClient(() =>
      json({ error: "API access requires an API key", upgrade_url: "https://metalcharts.org/pricing?tab=api" }, 401),
    );
    const err = await client.prices().catch((e) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err).toBeInstanceOf(MetalChartsError);
    expect(err.status).toBe(401);
    expect(err.message).toBe("API access requires an API key");
    expect(err.name).toBe("AuthenticationError");
  });

  test("403 is a PlanRequiredError with requiredPlan", async () => {
    const { client } = mockClient(() =>
      json(
        { error: "Your plan does not include this data class.", required_plan: "pro", upgrade_url: "https://metalcharts.org/pricing?tab=api" },
        403,
      ),
    );
    const err = await client.get<never>("/v1/cot", { metal: "XAU" }).catch((e) => e);
    expect(err).toBeInstanceOf(PlanRequiredError);
    expect(err.requiredPlan).toBe("pro");
    expect(err.upgradeUrl).toBe("https://metalcharts.org/pricing?tab=api");
  });

  test("403 for history depth has no requiredPlan", async () => {
    const { client } = mockClient(() => json({ error: "Requested history exceeds your plan's limit." }, 403));
    const err = await client.history("XAU", { range: "5Y" }).catch((e) => e);
    expect(err).toBeInstanceOf(PlanRequiredError);
    expect(err.requiredPlan).toBeUndefined();
  });

  test("429 reads Retry-After and the body, and is not retried", async () => {
    const { client, calls } = mockClient(() =>
      json(
        { error: "Rate limit exceeded", limit: 10, used: 11, window: "1m", retryAt: "2026-11-12T10:01:00.000Z" },
        429,
        { "retry-after": "17" },
      ),
    );
    const err = await client.prices().catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfter).toBe(17);
    expect(err.window).toBe("1m");
    expect(err.limit).toBe(10);
    expect(err.retryAt.toISOString()).toBe("2026-11-12T10:01:00.000Z");
    expect(calls.length).toBe(1);
  });

  test("429 without Retry-After falls back to retryAt", async () => {
    const retryAt = new Date(Date.now() + 120_000).toISOString();
    const { client } = mockClient(() => json({ error: "Monthly quota exceeded", retryAt, window: "1mo" }, 429));
    const err = await client.prices().catch((e) => e);
    expect(err.retryAfter).toBeGreaterThan(100);
    expect(err.retryAfter).toBeLessThanOrEqual(120);
  });

  test("400 is a plain MetalChartsError", async () => {
    const { client } = mockClient(() => json({ success: false, error: "Unsupported unit: gram" }, 400));
    const err = await client.prices({ unit: "gram" }).catch((e) => e);
    expect(err.constructor).toBe(MetalChartsError);
    expect(err.status).toBe(400);
    expect(err.message).toBe("Unsupported unit: gram");
  });

  test("non-JSON error bodies keep their text", async () => {
    const { client } = mockClient(() => new Response("NOT_FOUND", { status: 404 }));
    expect(client.get("/v1/nope")).rejects.toThrow("NOT_FOUND");
  });

  test("server errors are retried", async () => {
    const { client, calls } = mockClient((_c, i) =>
      i === 0 ? json({ error: "busy" }, 503) : json({ success: true, data: {} }),
    );
    const res = await client.prices();
    expect(res.success).toBe(true);
    expect(calls.length).toBe(2);
  });

  test("a 500 after retries keeps the support reference", async () => {
    const { client, calls } = mockClient(() => json({ success: false, error: "Internal error", reference: "ab12cd34" }, 500));
    const err = await client.prices().catch((e) => e);
    expect(err.reference).toBe("ab12cd34");
    expect(calls.length).toBe(3);
  });

  test("network failures become APIConnectionError", async () => {
    const { client, calls } = mockClient(
      () => {
        throw new TypeError("fetch failed");
      },
      { maxRetries: 1 },
    );
    const err = await client.prices().catch((e) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(err.cause).toBeInstanceOf(TypeError);
    expect(calls.length).toBe(2);
  });

  test("timeouts abort the request", async () => {
    const { client } = mockClient(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener("abort", () => reject(call.signal?.reason));
        }),
      { timeout: 20, maxRetries: 0 },
    );
    const err = await client.prices().catch((e) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(err.message).toContain("Timed out");
  });

  test("a caller's abort is passed through, not retried", async () => {
    const controller = new AbortController();
    const { client, calls } = mockClient(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const pending = client.prices({}, { signal: controller.signal }).catch((e) => e);
    controller.abort();
    const err = await pending;
    expect(err.name).toBe("AbortError");
    expect(calls.length).toBe(1);
  });
});
