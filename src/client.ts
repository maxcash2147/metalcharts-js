import {
  APIConnectionError,
  MetalChartsError,
  RateLimitError,
  errorFromResponse,
  parseRetryAfter,
} from "./errors.js";
import { SSEDecoder, readLines } from "./sse.js";
import type {
  ConvertParams,
  HistoryParams,
  HistoryResponse,
  InstrumentsParams,
  InstrumentsResponse,
  PricesParams,
  PricesResponse,
  Query,
  QueryValue,
  Quote,
  RequestOptions,
  StreamEvent,
  StreamPricesParams,
  UsageResponse,
} from "./types.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.metalcharts.org";
export const ENV_VAR = "METALCHARTS_API_KEY";

export interface MetalChartsOptions {
  /** Defaults to the METALCHARTS_API_KEY environment variable where one exists (Node, Bun, Deno). */
  apiKey?: string;
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default 30000. Does not apply to streams. */
  timeout?: number;
  /** Retries for 500/502/503/504 and network errors. Default 2. 429s are never retried. */
  maxRetries?: number;
  /** A fetch implementation. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

const RETRY_STATUSES = new Set([500, 502, 503, 504]);
// The stream sends a heartbeat about every 15 seconds, so 45 seconds of
// silence means the connection is dead even if the socket has not noticed.
const STREAM_IDLE_MS = 45_000;
const MAX_BACKOFF_MS = 30_000;

export class MetalCharts {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: MetalChartsOptions = {}) {
    const key = options.apiKey ?? envKey();
    if (!key) {
      throw new MetalChartsError(
        "No API key. Pass new MetalCharts({ apiKey }) or set the METALCHARTS_API_KEY " +
          "environment variable. Free keys: https://metalcharts.org/metals-api",
      );
    }
    this.#apiKey = key;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = options.timeout ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== "function") {
      throw new MetalChartsError("No fetch available. Use Node 18+ or pass options.fetch.");
    }
    this.#fetch = f.bind(globalThis);
  }

  /**
   * Latest prices keyed by symbol under `data`. One request covers every metal.
   *
   * @example
   * const { data } = await client.prices({ symbols: ["XAU", "XAG"], currency: "EUR", unit: "g" });
   */
  prices(params: PricesParams = {}, options?: RequestOptions): Promise<PricesResponse> {
    return this.get<PricesResponse>("/v1/prices", { ...params }, options);
  }

  /**
   * OHLC bars for a metal (XAU, XAG, XPT, XPD, HG, ...), oldest first, under `data`.
   * The free plan reads 30 days of daily bars.
   */
  history(symbol: string, params: HistoryParams = {}, options?: RequestOptions): Promise<HistoryResponse> {
    return this.get<HistoryResponse>(
      `/v1/history/${encodeURIComponent(symbol.trim())}`,
      { ...params },
      options,
    );
  }

  /** Every tracked instrument with its symbol, exchange and asset class. */
  instruments(params: InstrumentsParams = {}, options?: RequestOptions): Promise<InstrumentsResponse> {
    const { assetClass, ...rest } = params;
    return this.get<InstrumentsResponse>("/v1/instruments", { asset_class: assetClass, ...rest }, options);
  }

  /** Your plan, its limits and what you have used. Does not count against your quota. */
  usage(options?: RequestOptions): Promise<UsageResponse> {
    return this.get<UsageResponse>("/v1/usage", {}, options);
  }

  /** The supported metals. */
  metals(options?: RequestOptions): Promise<unknown> {
    return this.get("/v1/metals", {}, options);
  }

  /** Convert between a metal, a currency and a mass unit. */
  convert(params: ConvertParams, options?: RequestOptions): Promise<unknown> {
    return this.get("/v1/convert", { ...params }, options);
  }

  /**
   * GET any endpoint, for the ones without a method here. Undefined and null
   * values are dropped and arrays are joined with commas. A `format: "csv"`
   * response resolves to a string.
   *
   * @example
   * const cot = await client.get("/v1/cot", { metal: "XAU", range: "1Y" });
   */
  async get<T = unknown>(path: string, query: Query = {}, options: RequestOptions = {}): Promise<T> {
    const url = this.url(path, query);
    let attempt = 0;
    while (true) {
      const { signal, done } = timeoutSignal(this.timeout, options.signal);
      let res: Response;
      try {
        res = await this.#fetch(url, { headers: this.headers("application/json"), signal });
      } catch (err) {
        done();
        if (options.signal?.aborted) throw err;
        if (attempt < this.maxRetries) {
          attempt++;
          await this.sleep(backoff(attempt, 500), options.signal);
          continue;
        }
        throw new APIConnectionError(`Request to ${path} failed: ${describe(err)}`, { cause: err });
      }

      try {
        if (RETRY_STATUSES.has(res.status) && attempt < this.maxRetries) {
          attempt++;
          await res.body?.cancel().catch(() => {});
          const wait = (parseRetryAfter(res.headers.get("retry-after")) ?? 0) * 1000;
          await this.sleep(Math.min(Math.max(backoff(attempt, 500), wait), MAX_BACKOFF_MS), options.signal);
          continue;
        }
        if (!res.ok) throw await errorFromResponse(res);
        const contentType = res.headers.get("content-type") ?? "";
        return (contentType.includes("json") ? await res.json() : await res.text()) as T;
      } finally {
        done();
      }
    }
  }

  /**
   * Live prices over Server-Sent Events. Needs the Pro plan or above.
   *
   * Yields a `snapshot` event with every requested symbol first, then a
   * `price` event each time a quote changes. `event.quotes` holds the quotes
   * keyed by symbol for either type. The server may close the stream at any
   * time; by default the client reconnects with exponential backoff (capped
   * at 30 seconds) and the new connection starts with a fresh snapshot.
   * Authentication and plan errors are thrown straight away. Break out of the
   * loop, or abort `signal`, to close the connection.
   *
   * @example
   * for await (const event of client.streamPrices({ symbols: ["XAU"] })) {
   *   if (event.type === "price") console.log(event.data.symbol, event.data.price);
   * }
   */
  async *streamPrices(params: StreamPricesParams = {}): AsyncGenerator<StreamEvent, void, undefined> {
    const { symbols, currency, unit, reconnect = true, maxReconnectAttempts, signal } = params;
    const url = this.url("/v1/stream/prices", { symbols, currency, unit });
    let lastEventId: string | undefined;
    let retryMs: number | undefined;
    let failures = 0;
    let connectedBefore = false;

    while (!signal?.aborted) {
      let received = false;
      let wait = 0;
      let error: MetalChartsError = new APIConnectionError("Stream closed by the server");
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      let idle: ReturnType<typeof setTimeout> | undefined;
      const resetIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => controller.abort(), STREAM_IDLE_MS);
      };

      try {
        resetIdle();
        const headers = this.headers("text/event-stream");
        headers["Cache-Control"] = "no-cache";
        if (lastEventId !== undefined) headers["Last-Event-ID"] = lastEventId;
        const res = await this.#fetch(url, { headers, signal: controller.signal });
        if (res.status !== 200) throw await errorFromResponse(res);
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream") || !res.body) {
          await res.body?.cancel().catch(() => {});
          throw new MetalChartsError(
            `Expected text/event-stream, got ${contentType || "no content type"}`,
            { status: res.status },
          );
        }

        const decoder = new SSEDecoder(lastEventId);
        for await (const line of readLines(res.body, resetIdle)) {
          const sse = decoder.decode(line);
          if (!sse) continue;
          lastEventId = decoder.lastEventId;
          if (sse.retry !== undefined) retryMs = sse.retry;
          received = true;
          connectedBefore = true;
          failures = 0;
          // Event types this client doesn't know are skipped, so code written
          // today keeps working if the API adds some.
          const event = toStreamEvent(sse.event, sse.data, sse.id);
          if (signal?.aborted) return;
          if (event) yield event;
        }
        if (!reconnect) return;
      } catch (err) {
        if (signal?.aborted) return;
        if (err instanceof RateLimitError) {
          // Right after a drop the server can still count the old connection
          // for a moment, so a 429 on a reconnect is worth one more wait. On
          // the first connection it means the plan's connection limit is
          // reached, and waiting will not help.
          if (!reconnect || !connectedBefore || (err.retryAfter ?? 0) > 300) throw err;
          error = err;
          wait = (err.retryAfter ?? 0) * 1000;
        } else if (err instanceof MetalChartsError) {
          if (!reconnect || err.status === undefined || !RETRY_STATUSES.has(err.status)) throw err;
          error = err;
        } else {
          error = new APIConnectionError(`Stream connection failed: ${describe(err)}`, { cause: err });
          if (!reconnect) throw error;
        }
      } finally {
        clearTimeout(idle);
        signal?.removeEventListener("abort", onAbort);
        controller.abort();
      }

      if (!received) failures++;
      if (maxReconnectAttempts !== undefined && failures > maxReconnectAttempts) throw error;
      await this.sleep(Math.max(backoff(failures, retryMs), wait), signal);
    }
  }

  /** @internal Overridable for tests. Resolves early if `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
    });
  }

  private headers(accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: accept,
    };
    // Browsers manage User-Agent themselves; elsewhere it helps support.
    if (typeof (globalThis as { document?: unknown }).document === "undefined") {
      headers["User-Agent"] = `metalcharts-js/${VERSION}`;
    }
    return headers;
  }

  private url(path: string, query: Query): string {
    if (/^https?:\/\//i.test(path)) {
      throw new TypeError("Pass a path such as '/v1/prices', not a full URL");
    }
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      const encoded = encodeValue(value);
      if (encoded !== undefined) search.set(name, encoded);
    }
    const qs = search.toString();
    return `${this.baseUrl}/${path.replace(/^\/+/, "")}${qs ? `?${qs}` : ""}`;
  }
}

function toStreamEvent(type: string, raw: string, id: string | undefined): StreamEvent | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object") return undefined;
  const extra = id === undefined ? {} : { id };
  if (type === "snapshot") {
    const snapshot = data as { data?: Record<string, Quote>; timestamp: string };
    const quotes = { ...(snapshot.data ?? {}) };
    return { type, data: { data: quotes, timestamp: snapshot.timestamp }, quotes, ...extra };
  }
  if (type === "price") {
    const quote = data as Quote;
    return { type, data: quote, quotes: { [quote.symbol]: quote }, ...extra };
  }
  return undefined;
}

function encodeValue(value: QueryValue): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.join(",");
  return String(value);
}

function backoff(attempt: number, baseMs = 1000): number {
  const delay = Math.min(MAX_BACKOFF_MS, baseMs * 2 ** Math.max(0, attempt - 1));
  // Jitter keeps many clients from reconnecting in lockstep after an outage.
  return delay * (0.5 + Math.random() * 0.5);
}

function timeoutSignal(ms: number, outer?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Timed out after ${ms}ms`, "TimeoutError")),
    ms,
  );
  const onAbort = () => controller.abort(outer?.reason);
  if (outer?.aborted) controller.abort(outer.reason);
  else outer?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    },
  };
}

function envKey(): string | undefined {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    return env?.[ENV_VAR] || undefined;
  } catch {
    // Deno without --allow-env throws on access.
    return undefined;
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}
