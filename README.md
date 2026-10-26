# CallPool

[![license](https://img.shields.io/npm/l/call-pool)](https://github.com/Loykos/call-pool/blob/main/LICENSE)

HTTP request pool for Node.js with concurrency control, rate limits, quotas, retries and adaptive throttling. Use Undici, a Fetch-compatible client or impit to make requests while CallPool manages when they run.

## Installation

Requires Node.js `>=18.17`. CallPool is published as an ESM package.

```bash
pnpm install call-pool
```

## Examples

### Minimal example

```ts
import { CallPool } from "call-pool";

const pool = new CallPool({ baseUrl: "https://api.example.com" });

const users = await pool.request("/users");
await pool.close();
```

### Quota and rate limiting

Queue 100 requests with a limit of 100 HTTP attempts per minute. `minTime: "auto"` spaces attempts at least 600 ms apart, while `concurrency.limit` caps requests in progress at five. Retries count toward the same quota.

```ts
import { CallPool } from "call-pool";

const pool = new CallPool({
    baseUrl: "https://api.example.com",
    concurrency: { limit: 5 },
    rateLimit: {
        enabled: true,
        minTime: "auto",
        quota: {
            max: 100,
            window: 60_000,
        },
    },
});

const pages = Array.from({ length: 100 }, (_, i) => i + 1);
const results = await Promise.all(pages.map(page => pool.request(`/items?page=${page}`)));
await pool.close();
```

### All defaults

Only `baseUrl` is required. This shows all CallPool defaults in one place; additional native Undici options keep their own defaults. `adaptive.initialConcurrency` and transport `connections` follow `concurrency.limit` when omitted.

```ts
import { CallPool, undiciTransport } from "call-pool";

const pool = new CallPool({
    baseUrl: "https://api.example.com",
    defaultHeaders: {},
    maxElapsedTime: undefined,
    resolveStatus: undefined,

    concurrency: {
        limit: 1,
    },
    rateLimit: {
        enabled: false,
        minTime: 0,
        quota: undefined,
    },
    adaptive: {
        enabled: false,
        useTTFB: true,
        ignoreBelow: 100,
        congestionRatio: 2,
        breachLimit: 2,
        increaseStep: 1,
        decreaseFactor: 0.9,
        minConcurrency: 1,
        initialConcurrency: 1,
        rateLimitSignal: false, // true uses { decreaseFactor: 0.5, recoveryAfter: 10 }
    },
    retry: {
        maxAttempts: 3,
        codes: [403, 408, 429, "5xx"],
        networkErrors: true,
        delay: 1000,
        factor: 2,
        maxDelay: 60_000,
        maxRetryAfter: 60_000,
    },
    circuitBreaker: {
        enabled: false,
        codes: [403, 429, 503],
        failureThreshold: 3,
        halfOpen: {
            after: 10_000,
            maxRetryAfter: 60_000,
            maxConcurrent: 1,
            successThreshold: 2,
        },
    },
    transport: undiciTransport({
        network: {
            connections: 1,
            pipelining: 1,
            keepAliveTimeout: 10_000,
            headersTimeout: 30_000,
            bodyTimeout: 30_000,
        },
    }),
});

await pool.close();
```

## Full configuration

All options are optional except `baseUrl`. Durations are in milliseconds unless noted otherwise.

### Pool options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `baseUrl` | `string` | required | Base URL for all requests |
| `defaultHeaders` | `Record<string, string>` | `{}` | Request headers; per-request headers override them case-insensitively |
| `maxElapsedTime` | `number` | unlimited | Positive finite total request budget, including queue, attempts and retries |
| `resolveStatus` | `ResolveStatus` | none | Override response classification; see [Status resolution](#status-resolution) |
| `transport` | `TransportFactory` | `undiciTransport()` | HTTP client; see [Transports](#transports) |
| `network` | `NetworkOptions` | none | Deprecated shorthand for `undiciTransport({ network })`; cannot be combined with `transport` |

### Concurrency

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `concurrency.limit` | `number` | `1` | Maximum concurrent requests, including body reads and retry waits |

### Rate limits

| Option                   | Type              | Default | Description                                       |
| ------------------------ | ----------------- | ------- | ------------------------------------------------- |
| `rateLimit.enabled`      | `boolean`         | `false` | Apply request spacing and quota                   |
| `rateLimit.minTime`      | `number \| "auto"` | `0`     | Minimum spacing; `"auto"` derives it from `quota` |
| `rateLimit.quota.max`    | `number`          | none    | Maximum attempts per window                       |
| `rateLimit.quota.window` | `number`          | none    | Window duration; required with `quota.max`        |

Retries count against spacing and quota just like initial attempts.

### Adaptive throttling

When enabled, CallPool reduces concurrency as successful responses get slower and gradually restores it as latency recovers, up to `concurrency.limit`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `adaptive.enabled` | `boolean` | `false` | Adjust concurrency based on latency |
| `adaptive.useTTFB` | `boolean` | `true` | Measure time to response headers instead of the complete body |
| `adaptive.ignoreBelow` | `number` | `100` | Faster responses signal spare capacity and are excluded from the latency baseline |
| `adaptive.congestionRatio` | `number` | `2` | Latency above the moving average × this ratio signals congestion |
| `adaptive.breachLimit` | `number` | `2` | Consecutive congestion samples before reducing concurrency |
| `adaptive.increaseStep` | `number` | `1` | Concurrency slots added during recovery |
| `adaptive.decreaseFactor` | `number` | `0.9` | Concurrency multiplier on congestion; between 0 and 1, exclusive |
| `adaptive.minConcurrency` | `number` | `1` | Minimum concurrency; cannot exceed `concurrency.limit` |
| `adaptive.initialConcurrency` | `number` | `concurrency.limit` | Starting concurrency, between the minimum and limit |
| `adaptive.rateLimitSignal` | `boolean \| object` | `false` | Reduce concurrency on 429; `true` uses the defaults below |
| `adaptive.rateLimitSignal.decreaseFactor` | `number` | `0.5` | Concurrency multiplier, applied once per rate-limit episode; between 0 and 1, exclusive |
| `adaptive.rateLimitSignal.recoveryAfter` | `number` | `10` | Successful responses after the last 429 before concurrency can grow again |

The rate-limit signal requires `adaptive.enabled`. To pause the whole pool, enable the [circuit breaker](#circuit-breaker) as well.

### Retries

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `retry.maxAttempts` | `number` | `3` | Total HTTP attempts, including the first |
| `retry.codes` | `readonly StatusCodeSelector[]` | `[403, 408, 429, "5xx"]` | Failures to retry; replaces defaults, `[]` disables HTTP retries |
| `retry.networkErrors` | `boolean` | `true` | Retry transport failures independently of HTTP codes |
| `retry.delay` | `number` | `1000` | Initial wait without a valid `Retry-After` |
| `retry.factor` | `number` | `2` | Backoff multiplier per retry |
| `retry.maxDelay` | `number` | `60000` | Maximum backoff wait |
| `retry.maxRetryAfter` | `number` | `60000` | Maximum wait from a valid `Retry-After` |

Codes accept HTTP errors from 400 to 599, `"4xx"`, `"5xx"`, or a named status from [status resolution](#status-resolution). A valid `Retry-After` (seconds or HTTP date) replaces exponential backoff for that response. Cancellation and invalid local arguments are never retried.

### Circuit breaker

The circuit breaker pauses new attempts across the pool after repeated matching failures. Requests stay queued while it is open. After the wait, a limited number of requests test recovery; successful probes restore normal traffic, while a matching failure opens it again.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `circuitBreaker.enabled` | `boolean` | `false` | Enable the shared circuit |
| `circuitBreaker.codes` | `readonly StatusCodeSelector[]` | `[403, 429, 503]` | HTTP or named failures that count toward opening the circuit |
| `circuitBreaker.failureThreshold` | `number` | `3` | Consecutive matching failures across attempts in the pool |
| `circuitBreaker.halfOpen.after` | `number` | `10000` | Wait before recovery probes without a valid `Retry-After` |
| `circuitBreaker.halfOpen.maxRetryAfter` | `number` | `60000` | Maximum circuit wait from `Retry-After` |
| `circuitBreaker.halfOpen.maxConcurrent` | `number` | `1` | Maximum simultaneous recovery probes |
| `circuitBreaker.halfOpen.successThreshold` | `number` | `2` | Successful probes required to resume normal traffic |

Retry and circuit policies are independent: `retry.codes` decides whether to retry a request, while `circuitBreaker.codes` decides whether failures pause the pool. Network errors do not open the circuit. Set `maxElapsedTime` or pass an `AbortSignal` to bound waiting when a server keeps refusing requests.

### Status resolution

Use `resolveStatus` when an API reports an error inside a successful HTTP response.

```ts
import { CallPool } from "call-pool";

const pool = new CallPool({
    baseUrl: "https://maps.example.com",
    resolveStatus: ({ body }) => (body === "ERRX-2" ? "blocked" : undefined),
    retry: { codes: [403, 408, 429, "5xx", "blocked"] },
});

const map = await pool.request("/map");
await pool.close();
```

`resolveStatus({ status, headers, body })` runs after the body is read, before JSON parsing. The body is text or a `Buffer`. Its result determines success, retries, circuit breaking and rate-limit signals.

| Return value | Effect |
| --- | --- |
| `undefined` | Keep the HTTP status |
| Number from 100 to 599 | Use this status; below 400 succeeds |
| Named status, such as `"blocked"` | Fail; only matching named entries in `codes` apply |

Names start with a lowercase letter and contain lowercase letters, digits, `-` or `_`. The real HTTP status remains available in responses and errors alongside `resolvedStatus`. Resolver errors and invalid return values reject without retry.

### Transports

A transport controls **how an HTTP call is made**: the client, connections, proxy and TLS settings. Undici is the default; set `transport` to configure it or use another client.

```ts
import { CallPool, undiciTransport, fetchTransport } from "call-pool";

const proxied = new CallPool({
    baseUrl: "https://api.example.com",
    transport: undiciTransport({ network: { uri: "http://proxy.example.com:3128" } }),
});

const standard = new CallPool({
    baseUrl: "https://api.example.com",
    transport: fetchTransport(fetch),
});

await Promise.all([proxied.close(), standard.close()]);
```

For a browser's TLS and HTTP/2 fingerprint, install `impit` separately with `pnpm add impit`:

```ts
import { CallPool } from "call-pool";
import { impitTransport } from "call-pool/impit";

const browser = new CallPool({
    baseUrl: "https://api.example.com",
    transport: impitTransport({ browser: "chrome", timeout: 15_000 }),
});

const page = await browser.request("/page");
await browser.close();
```

| Transport | Use it for |
| --- | --- |
| `undiciTransport({ network })` | Connection pooling, proxies and TLS; used by default |
| `fetchTransport(fetch)` | Any Fetch-compatible client, including Node's global `fetch` |
| `impitTransport(options)` | Browser TLS and HTTP/2 fingerprints; import from `call-pool/impit` |

With impit, `proxyUrl` can be a string or a function such as `() => proxies.next()`. A function is called for the initial client and again before retries.

**Limits**

- Redirects are not followed by default. Undici-specific options apply only to `undiciTransport`.
- Fetch-based TTFB measurements require a client that resolves when headers arrive, before downloading the body.
- Undici checks timeouts roughly once per second, so very short timeouts can fire late.
- With impit, cancellation rejects immediately, but the request can keep its concurrency slot and delay `close()` until the body finishes or the native read fails. Its native timeout defaults to 30 seconds.
- In impit 0.14.7, a timeout while reading the body can leave the connection open. CallPool cannot guarantee connection closure in that case.

#### Undici network options

Pass native Undici `Pool.Options` to `undiciTransport({ network })`, or `ProxyAgent.Options` when `uri` is set. CallPool supplies these defaults:

| Option | Default | Description |
| --- | --- | --- |
| `connections` | `concurrency.limit` | Maximum transport connections |
| `pipelining` | `1` | HTTP pipelining; `0` disables keep-alive |
| `keepAliveTimeout` | `10000` | Keep-alive timeout |
| `headersTimeout` | `30000` | Response-header timeout |
| `bodyTimeout` | `30000` | Body inactivity timeout |

Other common native options:

| Option | Use |
| --- | --- |
| `uri` | Proxy URL |
| `token` | Proxy authorization |
| `headers` | Proxy headers; use `defaultHeaders` for target request headers |
| `connect` | Direct TLS options, such as `ca`, `cert` and `key` |
| `requestTls` | Target TLS options through a proxy |
| `proxyTls` | TLS options for an HTTPS proxy |

Certificates and keys are PEM content, for example `ca: readFileSync("./certs/ca.pem")`. Trust stays scoped to the pool. Per-request timeout options override network defaults; `0` keeps Undici's meaning of no timeout.

Keep-alive reuses connections and proxy tunnels. Use `pipelining: 0` for a fresh connection on each attempt, or `request(path, { reset: true })` to close it after that response. A fresh tunnel does not guarantee a different exit IP; that depends on the proxy provider.

### Request options

Pass these as the second argument to `pool.request<T>(path, options)`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `method` | `HttpMethod` | `"GET"` | HTTP method |
| `priority` | `number` | `5` | Queue priority from 0 to 9; lower runs first |
| `body` | `string \| Buffer \| Uint8Array \| object \| null` | none | Objects are serialized to JSON |
| `headers` | `Record<string, string>` | none | Override pool headers case-insensitively |
| `signal` | `AbortSignal \| null` | none | Cancel the request, including queue and retry waits |
| `timeout` | `number` | transport's | Attempt timeout; see below |
| `maxElapsedTime` | `number` | pool's | Override the total request budget, including queue and retries |
| `response` | `"body" \| "raw"` | `"body"` | Return the parsed body or `{ status, headers, body, resolvedStatus? }` |
| `binary` | `boolean` | `false` | Return a `Buffer` regardless of `Content-Type` |
| `exposeCookies` | `boolean` | `false` | Include real `Set-Cookie` values in raw responses |
| `resolveStatus` | `ResolveStatus` | pool's | Override [status resolution](#status-resolution) |

`timeout` covers the complete exchange for Fetch clients. For Undici it sets both header and body inactivity timeouts; explicit `headersTimeout` or `bodyTimeout` take precedence. A timed-out attempt may be retried. `maxElapsedTime` limits the whole request and is never retried; a known wait that exceeds the remaining budget rejects immediately.

Additional Undici request options such as `query`, `maxRedirections` and `reset` pass through to `undiciTransport`. `throwOnError` is excluded so CallPool can apply its error policy. Other transports ignore unsupported native options.

#### Responses

- `application/json` and `+json` media types are parsed as JSON. Text and missing `Content-Type` return a string; binary media types return a `Buffer`.
- Use `binary: true` for files when the server's content type may be wrong. Error bodies remain textual.
- Empty `HEAD`, `204`, `205` and `304` responses return `undefined`, or an empty `Buffer` in binary mode. Other empty or malformed JSON responses reject.
- `response: "raw"` adds status and headers without changing parsing or error handling. `Set-Cookie` is redacted unless `exposeCookies: true`; error headers always stay redacted.

The generic `T` describes the expected body type; it does not validate the response. Use `request<void>()` for an empty response. Literal `response: "raw"` returns `CallPoolResponse<T>`; options typed as `RequestOptions` return `T | CallPoolResponse<T>` when the mode is unknown.

#### Errors

| Error | Details |
| --- | --- |
| `CallPoolError` | HTTP failures expose `statusCode`, `body`, redacted `headers`, `retryable`, `retryAfterMs` and any `resolvedStatus` |
| `CallPoolTimeoutError` | Total budget exhausted; extends `CallPoolError`, exposes `maxElapsedTime`, never retried |
| Transport error | Network failures retain the client's original error; Fetch attempt timeouts use `TransportTimeoutError` |
| Cancellation | Rejects with `signal.reason`, never retried; an active attempt keeps its slot until the transport settles |

## Pool methods

| Method | Description |
| --- | --- |
| `request<T>(path, options?)` | Queue a request and resolve with its parsed body or raw response |
| `close()` | Reject queued requests, wait for active work, then close the transport |
| `getCurrentConcurrency()` | Current concurrency limit, including adaptive adjustments |
| `getStats()` | Snapshot of `{ queued, running, concurrency, pausedFor, circuitBreaker }` |

Circuit state is `"disabled"`, `"closed"`, `"open"` or `"half-open"`. `pausedFor` is the remaining open wait in milliseconds, or `0` otherwise.

## Migration notes

### 0.9.x to 0.10.0

Move top-level `network` to `transport: undiciTransport({ network })`. The old option still works, is deprecated, cannot be combined with `transport`, and will be removed in 1.0. Pools without `transport` continue using Undici.

`headersTimeout` and `bodyTimeout` remain available for Undici; `request(path, { timeout })` works with every transport.

### 0.7.x to 0.8.0

| Previous configuration | Replacement |
| --- | --- |
| `network.proxy` | `network.uri` |
| `network.timeout` | `network.headersTimeout` and `network.bodyTimeout` |
| `network.defaultHeaders` | Top-level `defaultHeaders` |
| `network.tls` | `network.connect` directly, or `network.requestTls` through a proxy |
| `CallPoolTlsOptions` | Native Undici TLS types; `NetworkOptions` is exported |
| `adaptive.rateLimitSignal.pause` | `circuitBreaker.enabled` |
| `rateLimit: { minTime, quota }` | Add `rateLimit.enabled: true` |
| Draft `retry.maxElapsedTime` / `retry.pauseCodes` | Top-level `maxElapsedTime` / `circuitBreaker` |

Removed keys throw a migration error. Rate limits and the circuit breaker are disabled by default. The adaptive rate-limit signal now adjusts concurrency only; enable the circuit breaker for shared pauses. Retries now include 403 by default and use a 1-second initial backoff, including for 429 without a valid `Retry-After`. Valid `Retry-After` also applies to other configured HTTP failures.

## Dependencies

- `undici`: default HTTP transport.
- `impit`: optional peer dependency, only needed for `call-pool/impit`.

Scheduling, rate limits and quotas have no additional dependencies.

## TODO

- Local monitoring UI with per-pool throughput, request and error logs, latency statistics, rate-limit/retry/throttling metrics and live charts.

## License

MIT
