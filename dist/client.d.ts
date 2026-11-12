import type { ConvertParams, HistoryParams, HistoryResponse, InstrumentsParams, InstrumentsResponse, PricesParams, PricesResponse, Query, RequestOptions, StreamEvent, StreamPricesParams, UsageResponse } from "./types.js";
export declare const DEFAULT_BASE_URL = "https://api.metalcharts.org";
export declare const ENV_VAR = "METALCHARTS_API_KEY";
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
export declare class MetalCharts {
    #private;
    readonly baseUrl: string;
    readonly timeout: number;
    readonly maxRetries: number;
    constructor(options?: MetalChartsOptions);
    /**
     * Latest prices keyed by symbol under `data`. One request covers every metal.
     *
     * @example
     * const { data } = await client.prices({ symbols: ["XAU", "XAG"], currency: "EUR", unit: "g" });
     */
    prices(params?: PricesParams, options?: RequestOptions): Promise<PricesResponse>;
    /**
     * OHLC bars for a metal (XAU, XAG, XPT, XPD, HG, ...), oldest first, under `data`.
     * The free plan reads 30 days of daily bars.
     */
    history(symbol: string, params?: HistoryParams, options?: RequestOptions): Promise<HistoryResponse>;
    /** Every tracked instrument with its symbol, exchange and asset class. */
    instruments(params?: InstrumentsParams, options?: RequestOptions): Promise<InstrumentsResponse>;
    /** Your plan, its limits and what you have used. Does not count against your quota. */
    usage(options?: RequestOptions): Promise<UsageResponse>;
    /** The supported metals. */
    metals(options?: RequestOptions): Promise<unknown>;
    /** Convert between a metal, a currency and a mass unit. */
    convert(params: ConvertParams, options?: RequestOptions): Promise<unknown>;
    /**
     * GET any endpoint, for the ones without a method here. Undefined and null
     * values are dropped and arrays are joined with commas. A `format: "csv"`
     * response resolves to a string.
     *
     * @example
     * const cot = await client.get("/v1/cot", { metal: "XAU", range: "1Y" });
     */
    get<T = unknown>(path: string, query?: Query, options?: RequestOptions): Promise<T>;
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
    streamPrices(params?: StreamPricesParams): AsyncGenerator<StreamEvent, void, undefined>;
    private headers;
    private url;
}
