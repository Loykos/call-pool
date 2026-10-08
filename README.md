# CallPool

[![license](https://img.shields.io/npm/l/call-pool)](https://github.com/Loykos/call-pool/blob/main/LICENSE)

HTTP request pool with rate limiting, quotas, automatic retry, and adaptive throttling for Node.js.

## Why CallPool?

Managing thousands of requests against rate-limited APIs is hard. Native `fetch` or simple `undici` requests loops often lead to **429 errors**, **socket exhaustion**, or **local memory spikes**.

**CallPool orchestrates your outbound traffic**, giving you precise control over concurrency, quotas, throttling and retries in a single, ready-to-use tool.

The tool uses a **Real-Time Adaptive Throttling** feature (based on the **EMA algorithm**) that gives you the ability to detect upstream congestion and adjust the request rate in real-time to protect your throughput.

## Features

-   **HTTP Connection Pool**: Uses [`undici`](https://github.com/nodejs/undici) to efficiently manage TCP connections
-   **Rate Limiting**: In-process priority scheduler with precise quota management, supporting both fixed windows and "auto" distribution
-   **Adaptive Throttling**: Real-time latency monitoring. It automatically slows down when the upstream service starts to lag, preventing 429s and timeouts
-   **Automatic Retry**: Built-in exponential backoff for network and server errors, with `Retry-After` header and `AbortSignal` support
-   **Per-Pool TLS**: Trust a private CA or present a client certificate on a single pool, without widening the trust store of the whole process

## Installation

Requires Node.js `>=18.17`. CallPool is published as an ESM package.

```bash
pnpm install call-pool
```

## Examples

### Minimal Example

Minimal configuration with only the base URL. Uses default values for all options.

```typescript
import { CallPool } from "call-pool";

const pool = new CallPool({
    baseUrl: "https://api.example.com",
});

const data = await pool.request("/endpoint");
await pool.close();
```

### Throttling and Quota Example

For services with rate limits (e.g., external APIs with contractual quotas). The pool automatically distributes requests across the time window.

```typescript
import { CallPool } from "call-pool";

const pool = new CallPool({
    baseUrl: "https://api.external-service.com",
    concurrency: {
        limit: 5, // Maximum 5 concurrent requests
    },
    rateLimit: {
        enabled: true,
        minTime: "auto", // Automatically calculates delay from quota
        quota: {
            max: 100, // 100 requests
            window: 60000, // in 60 seconds (1 minute)
        },
    },
    adaptive: {
        enabled: true, // Enable adaptive throttling
        congestionRatio: 2.5, // Slow down if latency > 2.5x the average
    },
    retry: {
        maxAttempts: 5, // Total attempts for external services
        delay: 2000, // 2 seconds initial wait
        factor: 2, // Exponential backoff between attempts: 2s, 4s, 8s, 16s
    },
});

const result = await pool.request("/api/data");
await pool.close();
```

### All defaults

`baseUrl` is required and has no default. Below are all CallPool defaults; additional `network` options retain Undici's defaults. `initialConcurrency` and `network.connections` follow the configured `concurrency.limit` unless explicitly overridden.

```typescript
import { CallPool } from "call-pool";

const pool = new CallPool({
    baseUrl: "https://api.example.com", // Required caller-supplied value
    concurrency: { limit: 1 },
    rateLimit: { enabled: false, minTime: 0, quota: undefined },
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
        rateLimitSignal: false,
    },
    maxElapsedTime: undefined,
    defaultHeaders: {},
    retry: {
        codes: [403, 408, 429, "5xx"],
        networkErrors: true,
        maxAttempts: 3,
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
    network: {
        connections: 1,
        pipelining: 1,
        keepAliveTimeout: 10_000,
        headersTimeout: 30_000,
        bodyTimeout: 30_000,
    },
});

// Usage examples
// JSON parsing is automatic for application/json and media types ending in +json
const users = await pool.request<User[]>("/users");

const newUser = await pool.request<User>("/users", {
    method: "POST",
    body: { name: "John", email: "john@example.com" }, // Automatically serialized to JSON
    priority: 1, // High priority
});

const urgent = await pool.request("/urgent", {
    method: "GET",
    priority: 1,
    headers: {
        "X-Custom-Header": "value",
    },
});

await pool.close();
```

## Configuration

### Base Configuration

| Option    | Type     | Required | Default | Description               |
| --------- | -------- | -------- | ------- | ------------------------- |
| `baseUrl` | `string` | Yes      | -       | Base URL for all requests |
| `defaultHeaders` | `Record<string, string>` | No | `{}` | Target request headers; per-request headers override them case-insensitively |
| `maxElapsedTime` | `number` | No | unlimited | Positive finite total request budget in ms, including queue; overridable per request |

### Concurrency Configuration

| Option              | Type     | Required | Default | Description                           |
| ------------------- | -------- | -------- | ------- | ------------------------------------- |
| `concurrency.limit` | `number` | No       | `1`     | Maximum number of concurrent requests |

### Rate Limit Configuration

| Option                               | Type               | Required | Default | Description                                                                                                                                      |
| ------------------------------------ | ------------------ | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rateLimit.enabled` | `boolean` | No | `false` | Enables spacing and quota; otherwise neither is applied |
| `rateLimit.minTime`                  | `number \| "auto"` | No       | `0`     | Minimum time between requests in ms, or `"auto"` for automatic calculation (requires `quota`)                                                    |
| `rateLimit.quota.max`                | `number`           | No       | -       | Maximum number of requests allowed in the time window                                                                                            |
| `rateLimit.quota.window`             | `number`           | No       | -       | Time window in ms (e.g., 60000 for 1 minute)                                                                                                     |

### Adaptive Configuration

| Option                    | Type      | Required | Default | Description                                                                                                      |
| ------------------------- | --------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `adaptive.enabled`        | `boolean` | No       | `false` | Enable adaptive throttling based on latency monitoring                                                           |
| `adaptive.useTTFB`        | `boolean` | No       | `true`  | Measure Time To First Byte instead of full body download                                                          |
| `adaptive.ignoreBelow`    | `number`  | No       | `100`   | Requests faster than this threshold are treated as headroom signals and excluded from the baseline                |
| `adaptive.congestionRatio` | `number`  | No       | `2.0`   | If latency > average × ratio, the request counts as congestion                                                    |
| `adaptive.breachLimit`    | `number`  | No       | `2`     | Consecutive congestion samples required before reducing concurrency                                               |
| `adaptive.increaseStep`   | `number`  | No       | `1`     | Number of concurrency slots added during recovery                                                                 |
| `adaptive.decreaseFactor` | `number`  | No       | `0.9`   | Multiplicative decrease factor applied during congestion. Must be greater than 0 and less than 1                  |
| `adaptive.minConcurrency` | `number`  | No       | `1`     | Lower bound for adaptive concurrency. Cannot exceed `concurrency.limit`                                           |
| `adaptive.initialConcurrency` | `number` | No    | `concurrency.limit` | Starting concurrency for the adaptive algorithm (slow-start). Must be between `minConcurrency` and `concurrency.limit` |
| `adaptive.rateLimitSignal` | `boolean \| object` | No | `false` | Treats a 429 as a pool-wide signal (see [Rate-limit signal](#rate-limit-signal)). `true` uses the defaults below |
| `adaptive.rateLimitSignal.decreaseFactor` | `number` | No | `0.5` | Multiplicative concurrency cut applied once per rate-limit episode. Must be greater than 0 and less than 1 |
| `adaptive.rateLimitSignal.recoveryAfter` | `number` | No | `10` | Successful responses required after the last 429 before concurrency may grow again |

### Retry Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `retry.maxAttempts` | `number` | `3` | Total HTTP attempts, including the first |
| `retry.codes` | `readonly (number \| "4xx" \| "5xx")[]` | `[403, 408, 429, "5xx"]` | HTTP failures to retry; replaces defaults, `[]` disables HTTP retries |
| `retry.networkErrors` | `boolean` | `true` | Retry transport failures independently of HTTP selectors |
| `retry.delay` | `number` | `1000` | Initial fallback wait in ms without a valid `Retry-After` |
| `retry.factor` | `number` | `2` | Fallback multiplier per retry |
| `retry.maxDelay` | `number` | `60000` | Cap in ms for fallback backoff, including the initial wait |
| `retry.maxRetryAfter` | `number` | `60000` | Cap in ms for waits from a valid `Retry-After` |

Numeric selectors must be integers from 400 to 599. A valid `Retry-After` (seconds or HTTP date) replaces the fallback for that response, capped by `retry.maxRetryAfter`. Missing, empty or invalid headers use `delay`, multiplied by `factor` after each failed attempt and capped by `maxDelay`. HTTP failures and transport failures use the same total attempt budget. Cancellation and invalid local arguments are never retried.

Retry waits occupy the logical request's concurrency slot. With concurrency 1, a retrying request therefore also holds up the queue even without a circuit breaker. Every actual retry acquires rate-limit and circuit permission again; waiting does not consume attempts or quota.

### Circuit Breaker Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `circuitBreaker.enabled` | `boolean` | `false` | Explicitly enable the shared circuit |
| `circuitBreaker.codes` | same selectors as `retry.codes` | `[403, 429, 503]` | HTTP failures that contribute to opening the circuit |
| `circuitBreaker.failureThreshold` | `number` | `3` | Consecutive matching failures across all HTTP attempts in the pool |
| `circuitBreaker.halfOpen.after` | `number` | `10000` | Fixed wait in ms before probes when Retry-After is missing/invalid |
| `circuitBreaker.halfOpen.maxRetryAfter` | `number` | `60000` | Independent cap for the server's requested circuit wait |
| `circuitBreaker.halfOpen.maxConcurrent` | `number` | `1` | Maximum simultaneous probe attempts, also subject to pool concurrency |
| `circuitBreaker.halfOpen.successThreshold` | `number` | `2` | Completed successful probes needed to restore normal traffic |

- **Closed:** attempts proceed normally. Matching failures, including retries and final failed attempts, increment a pool-wide counter. A completed successful response resets it. Non-matching HTTP errors and failures without a matching HTTP response do not increment or reset the counter. A matching HTTP refusal remains a failure even if reading its error body subsequently fails.
- **Open:** new attempts wait, including pending retries. The queue is retained; there is no `onOpen` switch or automatic fail-fast error. Requests already admitted can finish. A matching late failure from the same closed generation can extend this open period, never shorten it.
- **Half-open:** after the open wait expires, pending application requests are admitted as probes, up to `maxConcurrent`. No background health-check requests are generated. Successful probes count only after their bodies are fully consumed and parsed. Once `successThreshold` is reached, outstanding probes are drained before the circuit closes. Any matching failed probe reopens it immediately and resets recovery progress. Older generations cannot close or reopen a later probe cycle.

A non-matching HTTP error, transport/parser failure, or cancellation during a probe releases its permission without counting as recovery. Other pending requests can then probe; network errors remain governed by `retry.networkErrors`. The breaker classifies **HTTP codes**, not transport failures. If no work is pending, it sends nothing and creates no periodic timer.

The failure that opens/reopens the circuit supplies its `Retry-After`: a valid header replaces `halfOpen.after`, capped by `halfOpen.maxRetryAfter`. There is no implicit exponential escalation in the circuit; each unsuccessful probe cycle starts another fixed/header-directed wait. `halfOpen.after` is the delay before a probe cycle, not the interval between successful probes. Subsequent probes can start immediately, subject to rate limits.

The retry and breaker lists are independent and may overlap:

| Response matches | Refused request | Shared circuit |
| --- | --- | --- |
| `retry.codes` only | Retries while attempts remain | No failure contribution |
| `circuitBreaker.codes` only | Rejects after the response | Contributes to the opening threshold |
| Both | Retains its retry if attempts remain | Contributes to the opening threshold; retry waits for permission |
| Neither | Rejects | No failure contribution |

Retry and circuit waits overlap, never add up: each attempt waits until both policies allow it, then respects concurrency, spacing and quota. Their `maxRetryAfter` values are independent. Neither entering half-open nor closing the circuit resets a request's `maxAttempts` or `maxElapsedTime` budget.

The circuit works with `rateLimit.enabled: false` and `adaptive.enabled: false`. Without a total budget or cancellation, requests may remain queued while a portal keeps refusing. Configure `maxElapsedTime` to bound that waiting.

```ts
const pool = new CallPool({
    baseUrl: "https://portal.example.com",
    retry: { codes: [403, 408, 429, "5xx"], maxAttempts: 3 },
    circuitBreaker: {
        enabled: true,
        codes: [403, 429, 503],
        failureThreshold: 3,
        halfOpen: { after: 10_000, maxRetryAfter: 60_000, maxConcurrent: 1, successThreshold: 2 },
    },
});
```

#### Bounding requests against a persistently rate-limited server

`retry.maxDelay`, `retry.maxRetryAfter` and `circuitBreaker.halfOpen.maxRetryAfter` cap individual waits; repeated pauses can still keep a request and the queue behind it waiting for minutes. Set `maxElapsedTime` to bound the whole logical request, starting when it is submitted to the pool:

```ts
import { CallPool, CallPoolTimeoutError } from "call-pool";

const pool = new CallPool({
    baseUrl: "https://api.example.com",
    maxElapsedTime: 10_000,
    retry: { maxAttempts: 3 },
    circuitBreaker: { enabled: true },
});

try {
    const result = await pool.request("/resource");
} catch (error) {
    if (error instanceof CallPoolTimeoutError) {
        // Skip this resource: its remaining budget cannot accommodate the wait,
        // or its total deadline expired. The pool will not retry this error.
        console.warn("Request budget exhausted", error.maxElapsedTime);
    } else {
        throw error;
    }
} finally {
    await pool.close();
}
```

A known retry delay, quota/spacing wait, or pool pause that cannot fit in the remaining budget rejects immediately. New requests also fail before entering the scheduler when the current pool pause already exceeds their budget. Queued requests keep their original deadline; each retry uses the same budget. If a later 429 extends the pause, requests already waiting at the rate gate are checked again. Other waits, including active HTTP and body reads, are cancelled when the deadline expires.

`CallPoolTimeoutError` extends `CallPoolError`, has `retryable: false`, and exposes `maxElapsedTime`. When a retry is refused because its wait cannot fit, `cause` contains the original failure (including the 429 response details). The timeout itself has no HTTP status. Caller cancellation still preserves the caller's `signal.reason`. A timeout releases queued jobs or waiting permissions; an active HTTP attempt releases its slot when the transport settles after cancellation.

This budget works with or without adaptive throttling. It does not shorten the server's pool pause: later work can resume after that pause. `network.headersTimeout` and `network.bodyTimeout` govern transport waits within each attempt. Without `maxElapsedTime`, there is no total deadline. Pass `request(path, { maxElapsedTime: 2000 })` to override the pool default for one request; omitting it inherits the default.

### Network Configuration

`network` accepts native Undici `Pool.Options` for direct connections, or `ProxyAgent.Options` when `uri` is present. Values are forwarded to the selected constructor without renaming or filtering; native validation and semantics apply. Some transport validation happens on the first request.

CallPool supplies these defaults, which explicit network options override:

| Option | Default | Meaning |
| --- | --- | --- |
| `connections` | `concurrency.limit` | Maximum transport connections; independent of logical scheduler concurrency |
| `pipelining` | `1` | Native HTTP pipelining setting; `0` disables keep-alive |
| `keepAliveTimeout` | `10000` | Undici keep-alive timeout in ms |
| `headersTimeout` | `30000` | Undici response-header timeout in ms |
| `bodyTimeout` | `30000` | Undici body inactivity timeout in ms |

For options supported at both levels, request overrides take precedence over `network`, then CallPool defaults. `0` retains Undici's meaning for timeouts. Other constructor options, including connector functions, factories, interceptors and TLS settings, keep their native contract. Request-only options such as `reset` belong in `request()`.

#### Proxy and connection reuse

```ts
const pool = new CallPool({
    baseUrl: "https://api.example.com",
    network: {
        uri: "http://user:pass@proxy.example.com:3128",
        pipelining: 0, // New connection/tunnel for each HTTP attempt
        // token: "Basic ...", // Alternative native proxy authentication
    },
});
```

With Undici's default proxy tunnelling, HTTPS remains encrypted end to end with the target. The pool sees the target's responses and applies the same retry/pause policy. Native `network.headers` are **proxy headers**; use top-level `defaultHeaders` for the target.

Keep-alive normally reuses a CONNECT tunnel across requests. A rotating proxy that chooses an exit per tunnel will therefore keep that exit while the tunnel is reused, even without a sticky-session identifier. `pipelining: 0` creates fresh connections; alternatively `request(path, { reset: true })` closes the connection after that response. Use reset consistently if every request must close its connection. A fresh tunnel does not guarantee a different public IP: that depends on the proxy provider, eligible exits and session/lease policy. Sticky sessions remain the proxy's responsibility.

#### TLS

Use `network.connect` for direct TLS, `network.requestTls` for the target through a proxy, and `network.proxyTls` for an HTTPS proxy hop. Certificates and keys are PEM content, loaded by the caller. Native Undici/Node validation applies; CallPool no longer validates PEM strings itself. Trust remains scoped to each pool.

```ts
import { readFileSync } from "node:fs";

const direct = new CallPool({
    baseUrl: "https://api.internal.example.com",
    network: { connect: { ca: readFileSync("./certs/internal-ca.pem") } },
});

const proxied = new CallPool({
    baseUrl: "https://api.partner.example.com",
    network: {
        uri: "https://proxy.example.com:3128",
        proxyTls: { ca: readFileSync("./certs/proxy-ca.pem") },
        requestTls: {
            ca: readFileSync("./certs/partner-ca.pem"),
            cert: readFileSync("./certs/client.crt"),
            key: readFileSync("./certs/client.key"),
        },
    },
});
```

### Migrating from 0.7.x to 0.8.0

| Previous configuration | 0.8.0 |
| --- | --- |
| `network.proxy` | `network.uri` (native `ProxyAgent`) |
| `network.timeout` | `network.headersTimeout` and `network.bodyTimeout` |
| `network.defaultHeaders` | top-level `defaultHeaders` |
| `network.tls` | `network.connect` directly, or `network.requestTls` through a proxy |
| `CallPoolTlsOptions` | Undici's native connector/TLS types; `NetworkOptions` is exported |
| `adaptive.rateLimitSignal.pause` | `circuitBreaker.enabled` enables shared protection with controlled recovery |
| `rateLimit: { minTime, quota }` | Add `rateLimit.enabled: true` to apply either constraint |

The removed configuration keys throw a migration error for JavaScript callers instead of being silently ignored. If you used the unreleased `retry.maxElapsedTime` option, move it to top-level `maxElapsedTime` (also available per request). The draft `retry.pauseCodes` option was replaced by `circuitBreaker`; it is rejected at runtime and by TypeScript. Retry/breaker code overlap is intentionally allowed.

**Behavior changes:**

- `rateLimit` now requires `enabled: true`; spacing and quota are off by default, even if their values are supplied. Configuration values are still validated when disabled.
- `403` is now retried by default alongside 408, 429 and 5xx. Custom `retry.codes` replaces this list.
- The circuit breaker defaults to off, including with `adaptive.rateLimitSignal: true`. That adaptive option only controls concurrency reduction/recovery. To react to the first 429 pool-wide, use `circuitBreaker: { enabled: true, codes: [429], failureThreshold: 1 }`. Recovery now goes through half-open probes, instead of releasing the full queue when a timer expires.
- Without a valid `Retry-After`, retry waits use the same configurable fallback for every failure: 1s, 2s, 4s… capped by `maxDelay`, instead of the hidden 5s fallback for 429. Set `retry.delay: 5000` for a 5s initial retry. The circuit's separate fallback is `halfOpen.after` (10s by default), without implicit escalation.
- Valid `Retry-After` is honored for configured HTTP failures other than 429. Retry and circuit waits use their respective caps independently.

Native options are tied to the installed Undici major version (currently 6.x). No changes are required in the proxy server to configure client connection reuse.

## Request

Options for individual requests passed to the `request()` method.

**Note**: Response parsing is automatic. The media type in `Content-Type` is matched case-insensitively, ignoring parameters such as `charset`. `application/json` and types ending in `+json` (such as `application/vnd.api+json`) are parsed as JSON. Textual media types and responses without `Content-Type` return a string; binary media types return a byte-preserving `Buffer`. Request bodies that are JavaScript objects are automatically serialized to JSON with the appropriate `Content-Type` header.

Empty responses to `HEAD`, or with status `204`, `205`, or `304`, resolve with `undefined` (also as `body` in raw mode). With `binary: true`, they resolve with an empty `Buffer`. Other empty or malformed JSON responses still reject with a non-retryable `CallPoolError`. Use `request<void>()` when no content is expected, or include `undefined` in the body type when an endpoint can return either content or no content. HTTP errors still reject, including on `HEAD` requests.

**Fetching files**: a server that omits `Content-Type`, or labels a picture as text, would have its body decoded as UTF-8 and its bytes lost. Pass `binary: true` when you know you are downloading a file — the response then resolves as a `Buffer` whatever the header says, and JSON parsing is skipped. Error bodies stay textual, so a failure message is still readable.

```typescript
const image = await pool.request<Buffer>("/photos/1.jpg", { binary: true });
```

### Example

```typescript
const pool = new CallPool({
    baseUrl: "https://api.example.com",
});

// GET request with high priority
const data = await pool.request("/data", {
    priority: 1,
});

// POST request with custom headers
// Body objects are automatically serialized to JSON
const result = await pool.request("/users", {
    method: "POST",
    body: { name: "John", email: "john@example.com" },
    headers: {
        "X-Custom-Header": "value",
    },
});

// PUT request
// Response JSON is automatically parsed for application/json and +json media types
await pool.request("/users/123", {
    method: "PUT",
    body: { name: "Jane" },
});
```

### TypeScript Types

The `request()` method supports TypeScript generics for full type safety:

```typescript
// Define your types
interface User {
    id: number;
    name: string;
    email: string;
}

interface ApiResponse<T> {
    data: T;
    status: string;
}

const pool = new CallPool({
    baseUrl: "https://api.example.com",
});

// Type-safe request - TypeScript infers the return type
const users = await pool.request<User[]>("/users");
// users is typed as User[]

const user = await pool.request<User>("/users/123");
// user is typed as User

const response = await pool.request<ApiResponse<User>>("/users/123");
// response is typed as ApiResponse<User>
// response.data is typed as User

// POST with typed response
const newUser = await pool.request<User>("/users", {
    method: "POST",
    body: { name: "John", email: "john@example.com" },
});
// newUser is typed as User
```

### Options

| Option          | Type                                               | Required | Default  | Description                                                     |
| --------------- | -------------------------------------------------- | -------- | -------- | --------------------------------------------------------------- |
| `method`        | `HttpMethod`                                       | No       | `"GET"`  | HTTP method (GET, POST, PUT, DELETE, etc.)                      |
| `priority`      | `number`                                           | No       | `5`      | Queue priority (0-9, lower numbers run first; 0 is highest)     |
| `body`          | `string \| Buffer \| Uint8Array \| object \| null` | No       | -        | Request body (JS objects are automatically serialized to JSON)  |
| `headers`       | `Record<string, string>`                           | No       | -        | Additional headers for the single request                       |
| `signal`        | `AbortSignal \| null`                              | No       | -        | Cancels queued work, quota/minTime waits, HTTP and retries        |
| `response`      | `"body" \| "raw"`                                  | No       | `"body"` | `"raw"` resolves with a `{ status, headers, body }` envelope    |
| `exposeCookies` | `boolean`                                          | No       | `false`  | Reveals `Set-Cookie` in the raw envelope (redacted by default)  |

Header names are matched case-insensitively: request headers override `network.defaultHeaders`, so `authorization` replaces a default `Authorization`. If the same name appears with different casing within either object, the last entry wins. Each header name is sent once, and the input objects are left untouched.

Every other [undici `RequestOptions`](https://github.com/nodejs/undici/blob/main/docs/docs/api/Dispatcher.md#parameter-requestoptions) field (`query`, `maxRedirections`, `idempotent`, `headersTimeout`, ...) is passed through 1:1, except `throwOnError`, which is excluded because it would bypass the pool's error and retry policy.

### Raw Responses

By default `request()` resolves with the parsed body alone. With `response: "raw"` it resolves with the full envelope — same parsing rules, same error/retry semantics (4xx/5xx still reject with `CallPoolError`):

```typescript
const res = await pool.request<LoginPage>("/login", { response: "raw" });
// res: { status: number, headers: Record<string, ...>, body: LoginPage }

// 3xx responses do not throw and redirects are not followed by default,
// so raw mode lets you walk a redirect chain manually:
if (res.status === 302) {
    const next = res.headers["location"];
}
```

When options are held in a variable typed as `RequestOptions`, `request<T>()` returns `Promise<T | CallPoolResponse<T>>` because `response` can be either mode. Literal `response: "raw"` still returns `Promise<CallPoolResponse<T>>`; literal `"body"` or omitted options return `Promise<T>`.

`Set-Cookie` is redacted everywhere by default so session cookies can't leak through logged responses or errors. When the cookie **is** the data (e.g. session bootstrap), opt in per request:

```typescript
const res = await pool.request("/auth", { response: "raw", exposeCookies: true });
const cookies = res.headers["set-cookie"]; // real value(s)
```

Headers attached to `CallPoolError` stay redacted even with `exposeCookies: true`.

## Adaptive Throttling

Adaptive throttling is **disabled by default**. To enable it, set `adaptive.enabled` to `true`.

When enabled, the pool automatically monitors request latency and slows down when congestion is detected:

-   Calculates an exponential moving average (EMA) of latency
-   If requests are slower than the average multiplied by `adaptive.congestionRatio` for `adaptive.breachLimit` consecutive samples, it reduces concurrency
-   When requests become fast again, it restores concurrency gradually

With `adaptive.useTTFB: true` (the default), the controller receives the latency sample as soon as non-error response headers arrive, so scheduling can adapt while the body is still downloading. With `false`, the sample is recorded after the complete body download, before parsing. Each attempt contributes at most one sample; 4xx/5xx responses are excluded. In TTFB mode, a recorded sample is retained even if the subsequent body download fails.

Requests keep their concurrency slot until they finish, including body consumption and retries. Scheduler updates retain the existing 250 ms tuning interval.

### Rate-limit signal

The latency controller samples successful responses only, so on its own it never sees a 429: the refused request waits its `Retry-After`, and the other slots keep sending at full concurrency. With `adaptive.rateLimitSignal` a 429 steers the whole pool instead:

-   **One cut per episode**: concurrency is multiplied by `decreaseFactor` (never below `minConcurrency`, always at least one slot) and applied at once, without the tuning debounce. Every 429 received before the episode's wait is over extends it without cutting again, so the requests already in flight when the server starts refusing do not drive concurrency to its floor together.
-   **Separate circuit policy**: `circuitBreaker` controls shared waiting and probes independently of this signal and of `adaptive.enabled`.
-   **Recovery hold**: after the last 429 the controller may grow concurrency again only after `recoveryAfter` successful responses; until then the fast responses that would normally signal headroom do not.

The concurrency signal requires `adaptive.enabled`; it is ignored otherwise. Shared pauses do not require either option.

```typescript
const pool = new CallPool({
    baseUrl: "https://portal.example.com",
    concurrency: { limit: 10 },
    adaptive: { enabled: true, minConcurrency: 1, rateLimitSignal: { decreaseFactor: 0.5, recoveryAfter: 20 } },
});
```

## Introspection

-   `pool.getCurrentConcurrency()`: current concurrency limit (the live adaptive value when adaptive throttling is enabled)
-   `pool.getStats()`: live snapshot of the pool — `{ queued, running, concurrency, pausedFor, circuitBreaker }`
-   `circuitBreaker` is `"disabled"`, `"closed"`, `"open"` or `"half-open"`. `pausedFor` is the remaining open wait; it is 0 during half-open even while probe capacity is occupied.

## Error Handling

-   **429 (Rate Limit)**: Automatically detects `Retry-After` header and waits exactly that long (capped at `retry.maxRetryAfter`, default 60s) before retrying — no extra backoff is stacked on top. `circuitBreaker` optionally suspends other attempts and controls recovery; `adaptive.rateLimitSignal` separately reduces concurrency (see [Rate-limit signal](#rate-limit-signal))
-   **5xx (Server Error) and 408 (Request Timeout)**: Automatic retry with exponential backoff
-   **403 (Forbidden)**: Retried by default and included in the default circuit selectors when the breaker is enabled
-   **Other 4xx (Client Error)**: No retry by default; configurable with `retry.codes`
-   **Network Error**: Automatic retry with exponential backoff unless `retry.networkErrors: false`
-   **Invalid local request arguments**: Propagated immediately without retry
-   **AbortSignal**: Pass an optional `signal` to cancel a logical request, including scheduler queue, quota/`minTime` waits, HTTP/body download, and retry backoff. The rejection preserves `signal.reason`, and an aborted request is never retried. Cancelling while queued removes the job promptly; cancelling while waiting for rate permission releases its concurrency slot without charging that pending permission. An active HTTP attempt keeps its slot until the transport settles. Abort listeners and unused rate wake timers are removed when their waits end.

```typescript
const controller = new AbortController();
const pending = pool.request("/report", { signal: controller.signal });
controller.abort(new Error("Report no longer needed"));

try {
    await pending;
} catch (error) {
    if (error !== controller.signal.reason) throw error;
}
```

HTTP-level failures are thrown as `CallPoolError`, which exposes the response details:

```typescript
import { CallPool, CallPoolError } from "call-pool";

try {
    await pool.request("/users/999");
} catch (err) {
    if (err instanceof CallPoolError) {
        err.statusCode; // e.g. 404
        err.body; // raw response body
        err.headers; // response headers (Set-Cookie redacted)
        err.retryable; // whether policy permits retry, subject to attempts/budget
        err.retryAfterMs; // parsed/capped valid Retry-After, otherwise undefined
    }
}
```

Network-level failures (DNS, connection reset, socket timeout) propagate as the original `undici` errors.

**Backpressure note**: retry waits (backoff and `Retry-After`) happen while the logical request still occupies its concurrency slot. A retrying request therefore slows the whole pool down — intentional backpressure that prevents hammering a struggling upstream. Rate limits are acquired separately for every HTTP attempt, so retries count against `minTime` and quota just like initial attempts.

## Dependencies

-   `undici`: High-performance HTTP connection pool

Rate limiting, priority queueing and quota management are implemented in-process with zero additional dependencies.

## TODO

Funzionalità pianificate per le prossime versioni:

-   **Sistema di monitoraggio UI locale**: Interfaccia web avviata localmente per monitorare in tempo reale:
    -   Velocità di scodamento delle richieste per ogni pool
    -   Log delle richieste e degli errori
    -   Latenze medie, minime e massime per ogni pool
    -   Statistiche su rate limiting, retry e throttling
    -   Grafici e metriche in tempo reale

## License

MIT

## Development checks

```sh
pnpm typecheck
pnpm test:run       # Unit, integration, local end-to-end and compile-only API tests
pnpm test:e2e       # HTTPS/CONNECT and 429 recovery end-to-end only
```

The end-to-end suite requires `openssl` to generate temporary certificates. It starts loopback-only fixtures on ephemeral test ports and does not contact external portals or paid proxies. It verifies actual tunnel reuse and reconnection, TLS trust on each hop, timeout overrides, 429 queue behavior and 403 half-open recovery; it does not claim to verify provider public-IP rotation.
