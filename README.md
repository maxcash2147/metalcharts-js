# metalcharts

JavaScript and TypeScript client for the [MetalCharts API](https://metalcharts.org/metals-api): spot and historical prices for gold, silver, platinum, palladium, copper and base metals, plus COMEX inventory, LBMA vaults, Shanghai (SGE, SHFE), India MCX and CFTC Commitments of Traders data.

- No runtime dependencies. Uses the global `fetch`, so it runs on Node 18+, Bun, Deno, Cloudflare Workers and other edge runtimes.
- ESM with TypeScript types for every request and response
- Live price streaming over Server-Sent Events as an async iterator, with reconnects handled for you

## Install

```bash
npm install metalcharts
```

Get a free API key at [metalcharts.org/metals-api](https://metalcharts.org/metals-api). The free plan has 200 requests a month and 30 days of daily history, with no card.

> **Keep the key on the server.** Anything in browser code can be read by anyone who opens the page, including your API key. Call the API from your backend, a serverless function or an edge function, and send the prices to the browser from there.

## Quick start

```js
import { MetalCharts } from "metalcharts";

const client = new MetalCharts(); // reads the METALCHARTS_API_KEY environment variable

const { data } = await client.prices();
console.log(data.XAU.price, data.XAU.changePercent24h);
```

Where there is no environment (Workers, Deno without `--allow-env`), pass the key: `new MetalCharts({ apiKey: env.METALCHARTS_API_KEY })`.

One `prices()` call returns every metal, keyed by symbol: `XAU` gold, `XAG` silver, `XPT` platinum, `XPD` palladium, `HG` copper, plus `ALI`, `NI`, `ZN`, `PB` and others. Ask for fewer with `symbols`:

```js
await client.prices({ symbols: ["XAU", "XAG"] });
```

## Currency, unit and karat

Prices are in US dollars per each market's own unit (troy ounce for precious metals) unless you ask otherwise:

```js
// Gold in euros per gram
await client.prices({ symbols: "XAU", currency: "EUR", unit: "g" });

// 22 karat gold in Indian rupees per gram
await client.prices({ symbols: "XAU", currency: "INR", unit: "g", karat: 22 });
```

- `currency`: 32 ISO codes, including USD, EUR, GBP, JPY, CHF, AUD, CAD, CNY, INR and AED. Converted at the ECB reference rate.
- `unit`: `toz`, `g`, `kg`, `lb`, `mt` or `tola`.
- `karat`: 24, 23, 22, 21, 20, 18, 16, 15, 14, 12, 10, 9 or 8 (gold only).

## Historical prices

```js
const { data: bars } = await client.history("XAU", { range: "1M", interval: "1d" });
for (const bar of bars.slice(-5)) console.log(bar.timestamp, bar.close);
```

Pick the window with `range` (`1M`, `6M`, `1Y`, `5Y`, `ALL`) or with `start` and `end` (`"YYYY-MM-DD"` strings, or `Date` objects, sent as their UTC date). `interval` is one of `15m`, `30m`, `45m`, `1h`, `2h`, `4h`, `8h`, `1d`, `1w`, `1M`. `currency`, `unit` and `karat` work here too, converted at each day's rate.

How far back you can go depends on the plan: the free plan reads the last 30 days of daily bars, Starter and Basic one year with intraday intervals, Pro five years, and Ultimate the full series (gold and silver daily bars go back to 1966).

## Other endpoints

| Method | Endpoint |
|---|---|
| `prices()` | `GET /v1/prices` |
| `history(symbol)` | `GET /v1/history/{symbol}` |
| `instruments()` | `GET /v1/instruments` |
| `metals()` | `GET /v1/metals` |
| `convert({ from, to })` | `GET /v1/convert` |
| `usage()` | `GET /v1/usage` (your plan and what you've used; costs nothing) |
| `streamPrices()` | `GET /v1/stream/prices` (see below) |

Everything else goes through `get()`:

```js
// CFTC Commitments of Traders for gold (Pro plan)
const cot = await client.get("/v1/cot", { metal: "XAU", range: "1Y" });

// COMEX silver warehouse stocks (Pro plan)
const comex = await client.get("/v1/comex/inventory", { symbol: "XAG", range: "3M" });

// Any list endpoint as CSV text
const csv = await client.get("/v1/history/XAU", { range: "1M", format: "csv" });
```

In TypeScript, give `get()` the response type you expect: `client.get<MyCotResponse>(...)`. The [API reference](https://metalcharts.org/metals-api/docs) lists every endpoint, parameter and response field, and which plan each one needs.

Every method takes a last `{ signal }` argument to cancel the request with an `AbortController`. Requests time out after 30 seconds by default (`new MetalCharts({ timeout: 10_000 })`).

## Live prices (streaming)

On the Pro plan and above, `streamPrices()` holds one connection open and yields an event each time a price changes, so you don't spend requests polling:

```js
import { MetalCharts } from "metalcharts";

const client = new MetalCharts();
const latest = {};

for await (const event of client.streamPrices({ symbols: ["XAU", "XAG"] })) {
  Object.assign(latest, event.quotes);
  if (event.type === "price") {
    console.log(event.data.symbol, event.data.price, event.data.timestamp);
  }
}
```

- The first event on every connection is a `snapshot` with all requested symbols. After that each `price` event carries one symbol's full quote, the same shape as a quote from `prices()`.
- `event.quotes` gives the quotes keyed by symbol for both event types, so `Object.assign(latest, event.quotes)` keeps a current table.
- `currency` and `unit` work as they do for `prices()`.
- If the connection drops or the server closes it, the client reconnects with backoff and starts again from a fresh snapshot. Pass `reconnect: false` to handle that yourself, or `maxReconnectAttempts: 10` to give up after ten failed attempts in a row.
- `break` out of the loop, or pass a `signal` and abort it, to close the connection. Event types other than `snapshot` and `price` are skipped.
- Concurrent connections per account: Pro 1, Ultimate 10, Enterprise 50. Other plans get a `PlanRequiredError`, and opening one connection too many gets a `RateLimitError`.

To push prices on to browsers, run the stream on your server and fan it out over your own WebSocket or SSE endpoint. That keeps the key private and uses one connection for all your users.

## Errors

Every error extends `MetalChartsError`, which has `status`, `message`, `body` and `upgradeUrl`.

| Error | When |
|---|---|
| `AuthenticationError` | 401: the key is missing or invalid |
| `PlanRequiredError` | 403: your plan doesn't include the data, or the history range reaches past your plan's limit. `requiredPlan` names the plan that does (undefined for history depth) |
| `RateLimitError` | 429: per-minute limit or monthly allowance used up. `retryAfter` is the wait in seconds, `window` is `"1m"` or `"1mo"` |
| `APIConnectionError` | No response: DNS, TLS, timeout or a dropped connection |
| `MetalChartsError` | Anything else, such as a 400 for an invalid parameter |

```js
import { MetalCharts, PlanRequiredError, RateLimitError } from "metalcharts";

const client = new MetalCharts();

try {
  const { data } = await client.history("XAU", { range: "5Y" });
} catch (err) {
  if (err instanceof PlanRequiredError) {
    console.log(`Needs a bigger plan (${err.requiredPlan ?? "more history"}): ${err.upgradeUrl}`);
  } else if (err instanceof RateLimitError && err.window === "1m") {
    await new Promise((r) => setTimeout(r, (err.retryAfter ?? 60) * 1000));
  } else {
    throw err;
  }
}
```

Server errors (500, 502, 503, 504) and network failures are retried twice with backoff before an error is thrown; set `maxRetries: 0` to turn that off. 429s are never retried automatically.

## Limits

Each request costs weight: most endpoints 1, history and news 2, news search and sentiment 3, `usage()` 0. The per-minute limit is per key and the monthly allowance is per account. Every response carries `X-RateLimit-*` headers, and `client.usage()` returns your plan, its limits and what you've used this month.

On the free plan, any public page or app that shows the data needs a visible link to https://metalcharts.org, such as "Metal prices by MetalCharts". Paid plans don't need it. Commercial use is allowed on every plan.

## Links

- [API reference](https://metalcharts.org/metals-api/docs)
- [Pricing](https://metalcharts.org/api-pricing)
- [OpenAPI 3.0 document](https://api.metalcharts.org/docs/json)
- [Examples in other languages](https://github.com/maxcash2147/metalcharts-api-examples)
- Python client: `pip install metalcharts`

## Development

```bash
bun install
bun test
bun run typecheck
bun run build
```

## License

MIT. Use of the API itself is covered by the [API terms](https://metalcharts.org/api-terms).
