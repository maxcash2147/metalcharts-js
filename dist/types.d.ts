/** Mass units the API quotes in. `oz` is accepted as an alias for the troy ounce. */
export type MassUnit = "toz" | "oz" | "g" | "kg" | "lb" | "mt" | "tola";
/** Candle sizes for /v1/history. The free plan reads daily bars only. */
export type Interval = "15m" | "30m" | "45m" | "1h" | "2h" | "4h" | "8h" | "1d" | "1w" | "1M";
/** Common history windows. Other tokens such as 3M, 2Y or YTD are passed through. */
export type Range = "1M" | "3M" | "6M" | "YTD" | "1Y" | "2Y" | "5Y" | "10Y" | "ALL" | (string & {});
export type QueryValue = string | number | boolean | Date | readonly string[] | null | undefined;
export type Query = Record<string, QueryValue>;
export interface RequestOptions {
    /** Abort the request. */
    signal?: AbortSignal;
}
export interface PricesParams {
    /** "XAU,XAG" or ["XAU", "XAG"]. Omit for every metal. */
    symbols?: string | readonly string[];
    /** ISO 4217 code such as "EUR". Default USD. */
    currency?: string;
    /** Default: each market's own unit (troy ounce for precious metals). */
    unit?: MassUnit | (string & {});
    /** Gold only: 24, 22, 18, 14 and so on. */
    karat?: number | string;
}
export interface HistoryParams {
    range?: Range;
    interval?: Interval | (string & {});
    /** "YYYY-MM-DD" or a Date (sent as its UTC date). Overrides `range`. */
    start?: string | Date;
    /** "YYYY-MM-DD" or a Date. Used with `start`; defaults to now. */
    end?: string | Date;
    currency?: string;
    unit?: MassUnit | (string & {});
    karat?: number | string;
}
export interface InstrumentsParams {
    /** commodity, crypto, equity, etf, fx, index or bond. */
    assetClass?: string;
    exchange?: string;
    search?: string;
    limit?: number;
}
export interface ConvertParams {
    /** A metal symbol (XAU), a currency (EUR) or a unit (g). */
    from: string;
    to: string;
    amount?: number;
    unit?: MassUnit | (string & {});
    karat?: number | string;
    /** Convert at that day's closing price instead of live. Counts as history. */
    date?: string | Date;
}
export interface StreamPricesParams {
    symbols?: string | readonly string[];
    currency?: string;
    unit?: MassUnit | (string & {});
    /** Reconnect with backoff when the connection drops. Default true. */
    reconnect?: boolean;
    /** Give up after this many failed attempts in a row. Default: keep trying. */
    maxReconnectAttempts?: number;
    /** Abort to close the stream; the loop then ends without an error. */
    signal?: AbortSignal;
}
/** One symbol's latest price. */
export interface Quote {
    symbol: string;
    price: number;
    change24h?: number | null;
    changePercent24h?: number | null;
    open24h?: number | null;
    high24h?: number | null;
    low24h?: number | null;
    /** Indicative bid, a fixed spread below the mid price. */
    bid?: number | null;
    /** Indicative ask, a fixed spread above the mid price. */
    ask?: number | null;
    exchange: string;
    marketType: string;
    timestamp: string;
    /** True when this quote's feed hasn't updated for more than five days. */
    stale?: boolean;
    /** Present when the request set currency, unit or karat. */
    currency?: string;
    unit?: string;
    karat?: number;
    purity?: number;
}
export interface PricesResponse {
    success: boolean;
    data: Record<string, Quote>;
    count: number;
    source: string;
    cacheAge?: number | null;
    isStale: boolean;
    timestamp: string;
    currency?: string;
    fx?: {
        rate: number;
        date: string;
        source: string;
    };
    _rid?: string;
}
/** One OHLC bar. `price` equals `close`. */
export interface Bar {
    timestamp: string;
    price: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}
export interface HistoryResponse {
    success: boolean;
    data: Bar[];
    symbol: string;
    range: string;
    startDate: string;
    endDate: string;
    count: number;
    source: string;
    exchange?: string | null;
    currency?: string;
    unit?: string;
    _rid?: string;
}
export interface Instrument {
    symbol: string;
    name: string;
    assetClass?: string | null;
    exchange?: string | null;
    marketType?: string | null;
    currency?: string | null;
    unit?: string | null;
}
export interface InstrumentsResponse {
    success: boolean;
    count: number;
    data: Instrument[];
}
export interface UsageResponse {
    tier: string;
    creditCode?: string;
    limits: {
        weightPerMinute: number;
        monthlyWeight: number | null;
        maxKeys: number;
        maxHistoryYears: number | null;
        maxHistoryDays: number | null;
        intradayHistory: boolean;
    };
    usage: {
        today: number;
        month: number;
        keysActive: number;
    };
    dailyHistory: {
        date: string;
        requests: number;
        weight: number;
    }[];
}
/** First event on every stream connection: every requested symbol. */
export interface SnapshotEvent {
    type: "snapshot";
    data: {
        data: Record<string, Quote>;
        timestamp: string;
    };
    /** The quotes keyed by symbol. */
    quotes: Record<string, Quote>;
    id?: string;
}
/** Sent each time one symbol's quote changes. */
export interface PriceEvent {
    type: "price";
    data: Quote;
    /** `{ [data.symbol]: data }`, so `Object.assign(latest, event.quotes)` works for both event types. */
    quotes: Record<string, Quote>;
    id?: string;
}
export type StreamEvent = SnapshotEvent | PriceEvent;
