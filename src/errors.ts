/** Base class for every error this package throws. */
export class MetalChartsError extends Error {
  override name = "MetalChartsError";
  /** HTTP status, or undefined when no response arrived. */
  readonly status: number | undefined;
  /** The decoded JSON error body (empty when there was none). */
  readonly body: Record<string, unknown>;
  /** Link to the pricing page, present on plan and quota errors. */
  readonly upgradeUrl: string | undefined;
  /** Support reference, present on 500 errors. Quote it when asking for help. */
  readonly reference: string | undefined;

  constructor(
    message: string,
    options: { status?: number; body?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.status = options.status;
    this.body = options.body ?? {};
    this.upgradeUrl = str(this.body.upgrade_url);
    this.reference = str(this.body.reference);
  }
}

/** The request failed before an HTTP response arrived (DNS, TLS, timeout, reset). */
export class APIConnectionError extends MetalChartsError {
  override name = "APIConnectionError";
}

/** 401: the API key is missing, malformed, revoked or unknown. */
export class AuthenticationError extends MetalChartsError {
  override name = "AuthenticationError";
}

/**
 * 403: the request needs a higher plan. `requiredPlan` names the lowest plan
 * that allows it (for example "pro"). It is undefined when the plan has the
 * data but not this much of it, such as a history range that reaches further
 * back than the plan allows.
 */
export class PlanRequiredError extends MetalChartsError {
  override name = "PlanRequiredError";
  readonly requiredPlan: string | undefined;

  constructor(message: string, options: { status?: number; body?: Record<string, unknown> } = {}) {
    super(message, { status: 403, ...options });
    this.requiredPlan = str(this.body.required_plan);
  }
}

/**
 * 429: the per-minute limit or the monthly allowance is used up.
 * `retryAfter` is the wait in seconds. `window` is "1m" for the per-minute
 * limit and "1mo" for the monthly allowance.
 */
export class RateLimitError extends MetalChartsError {
  override name = "RateLimitError";
  readonly retryAfter: number | undefined;
  readonly retryAt: Date | undefined;
  readonly limit: number | undefined;
  readonly window: string | undefined;

  constructor(
    message: string,
    options: { status?: number; body?: Record<string, unknown>; retryAfter?: number } = {},
  ) {
    super(message, { status: 429, ...options });
    const at = str(this.body.retryAt);
    const parsed = at ? new Date(at) : undefined;
    this.retryAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined;
    this.retryAfter =
      options.retryAfter ??
      (this.retryAt ? Math.max(0, (this.retryAt.getTime() - Date.now()) / 1000) : undefined);
    this.limit = typeof this.body.limit === "number" ? this.body.limit : undefined;
    this.window = str(this.body.window);
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Seconds from a Retry-After header, which is either seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, (when - Date.now()) / 1000);
}

/** Read an error response and build the matching error. */
export async function errorFromResponse(res: Response): Promise<MetalChartsError> {
  const text = await res.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON: fall back to the text below.
  }
  const message =
    str(body.error) ?? str(body.message) ?? (text.trim().slice(0, 200) || `HTTP ${res.status}`);

  switch (res.status) {
    case 401:
      return new AuthenticationError(message, { status: 401, body });
    case 403:
      return new PlanRequiredError(message, { status: 403, body });
    case 429: {
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      return new RateLimitError(message, {
        status: 429,
        body,
        ...(retryAfter === undefined ? {} : { retryAfter }),
      });
    }
    default:
      return new MetalChartsError(message, { status: res.status, body });
  }
}
