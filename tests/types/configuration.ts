import type { Pool, ProxyAgent } from "undici";
import { CallPool, type CallPoolOptions, type NetworkOptions, type RequestOptions } from "../../src/index.js";

declare const direct: Pool.Options;
declare const proxy: ProxyAgent.Options;
const directOptions: NetworkOptions = direct;
const proxyOptions: NetworkOptions = proxy;
new CallPool({ baseUrl: "https://example.com", network: directOptions });
new CallPool({ baseUrl: "https://example.com", network: proxyOptions });
new CallPool({
    baseUrl: "https://example.com",
    maxElapsedTime: 5000,
    defaultHeaders: { "x-target": "value" },
    retry: { codes: [408, 429, "5xx"] as const, pauseCodes: [429], maxDelay: 10000, networkErrors: false },
    network: { uri: "http://proxy.example.com", pipelining: 0, headersTimeout: 1000, requestTls: { ca: "pem" }, proxyTls: { servername: "proxy.example.com" } },
});
const overrides: RequestOptions = { maxElapsedTime: 1000, reset: true, headersTimeout: 0, bodyTimeout: 500 };
declare const pool: CallPool;
pool.request("/", overrides);
// @ts-expect-error Old network alias was removed.
const oldProxy: CallPoolOptions = { baseUrl: "http://example.com", network: { proxy: "http://proxy.example.com" } };
// @ts-expect-error Default target headers are no longer transport options.
const oldHeaders: CallPoolOptions = { baseUrl: "http://example.com", network: { defaultHeaders: {} } };
// @ts-expect-error Total budget belongs at root/request level.
const oldDeadline: CallPoolOptions = { baseUrl: "http://example.com", retry: { maxElapsedTime: 1000 } };
// @ts-expect-error Pauses belong to the retry policy.
const oldPause: CallPoolOptions = { baseUrl: "http://example.com", adaptive: { rateLimitSignal: { pause: true } } };
// @ts-expect-error Only 4xx/5xx family selectors are supported.
const badCodes: CallPoolOptions = { baseUrl: "http://example.com", retry: { codes: ["3xx"] } };
