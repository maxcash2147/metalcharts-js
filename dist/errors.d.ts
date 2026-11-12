/** Base class for every error this package throws. */
export declare class MetalChartsError extends Error {
    name: string;
    /** HTTP status, or undefined when no response arrived. */
    readonly status: number | undefined;
    /** The decoded JSON error body (empty when there was none). */
    readonly body: Record<string, unknown>;
    /** Link to the pricing page, present on plan and quota errors. */
    readonly upgradeUrl: string | undefined;
    /** Support reference, present on 500 errors. Quote it when asking for help. */
    readonly reference: string | undefined;
    constructor(message: string, options?: {
        status?: number;
        body?: Record<string, unknown>;
        cause?: unknown;
    });
}
/** The request failed before an HTTP response arrived (DNS, TLS, timeout, reset). */
export declare class APIConnectionError extends MetalChartsError {
    name: string;
}
/** 401: the API key is missing, malformed, revoked or unknown. */
export declare class AuthenticationError extends MetalChartsError {
    name: string;
}
/**
 * 403: the request needs a higher plan. `requiredPlan` names the lowest plan
 * that allows it (for example "pro"). It is undefined when the plan has the
 * data but not this much of it, such as a history range that reaches further
 * back than the plan allows.
 */
export declare class PlanRequiredError extends MetalChartsError {
    name: string;
    readonly requiredPlan: string | undefined;
    constructor(message: string, options?: {
        status?: number;
        body?: Record<string, unknown>;
    });
}
/**
 * 429: the per-minute limit or the monthly allowance is used up.
 * `retryAfter` is the wait in seconds. `window` is "1m" for the per-minute
 * limit and "1mo" for the monthly allowance.
 */
export declare class RateLimitError extends MetalChartsError {
    name: string;
    readonly retryAfter: number | undefined;
    readonly retryAt: Date | undefined;
    readonly limit: number | undefined;
    readonly window: string | undefined;
    constructor(message: string, options?: {
        status?: number;
        body?: Record<string, unknown>;
        retryAfter?: number;
    });
}
/** Seconds from a Retry-After header, which is either seconds or an HTTP date. */
export declare function parseRetryAfter(value: string | null | undefined): number | undefined;
/** Read an error response and build the matching error. */
export declare function errorFromResponse(res: Response): Promise<MetalChartsError>;
