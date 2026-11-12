/**
 * JavaScript and TypeScript client for the MetalCharts metals price API.
 *
 *   import { MetalCharts } from "metalcharts";
 *   const client = new MetalCharts(); // reads METALCHARTS_API_KEY
 *   const { data } = await client.prices({ symbols: "XAU" });
 *
 * Docs: https://metalcharts.org/metals-api/docs
 */
export { MetalCharts, DEFAULT_BASE_URL, ENV_VAR } from "./client.js";
export type { MetalChartsOptions } from "./client.js";
export {
  MetalChartsError,
  APIConnectionError,
  AuthenticationError,
  PlanRequiredError,
  RateLimitError,
} from "./errors.js";
export type * from "./types.js";
export { VERSION } from "./version.js";
