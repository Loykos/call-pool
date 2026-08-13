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

### Full Configuration Example

Complete configuration with all options explicitly set.

```typescript
import { CallPool } from "call-pool";

const pool = new CallPool({
    baseUrl: "https://api.example.com",
    concurrency: {
        limit: 20, // 20 concurrent requests
    },
    rateLimit: {
        minTime: 50, // 50ms between each request (or "auto" if using quota)
        quota: {
            max: 1000, // 1000 requests
            window: 3600000, // in 1 hour
        },
    },
    adaptive: {
        enabled: true, // Enable adaptive throttling
        useTTFB: true, // Measure time to first byte instead of full download
        ignoreBelow: 100, // Treat very fast requests as headroom signals
        congestionRatio: 2.0, // Threshold for adaptive throttling
        breachLimit: 2, // Consecutive congestion samples before slowing down
        increaseStep: 1, // Additive recovery step
        decreaseFactor: 0.9, // Multiplicative backoff factor
        minConcurrency: 1, // Adaptive lower bound
    },
    retry: {
        maxAttempts: 3, // Maximum 3 total attempts
        delay: 1000, // 1 second initial delay
        factor: 2, // Backoff between attempts: 1s, 2s
    },
    network: {
        timeout: 30000, // 30 seconds timeout
        defaultHeaders: {
            Authorization: "Bearer your-token-here",
            "User-Agent": "MyApp/1.0",
            "Content-Type": "application/json",
        },
    },
});

// Usage examples
// JSON parsing is automatic when Content-Type is application/json
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

### Concurrency Configuration

| Option              | Type     | Required | Default | Description                           |
| ------------------- | -------- | -------- | ------- | ------------------------------------- |
| `concurrency.limit` | `number` | No       | `1`     | Maximum number of concurrent requests |

### Rate Limit Configuration

| Option                               | Type               | Required | Default | Description                                                                                                                                      |
| ------------------------------------ | ------------------ | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
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

### Retry Configuration

| Option              | Type     | Required | Default | Description                                         |
| ------------------- | -------- | -------- | ------- | --------------------------------------------------- |
| `retry.maxAttempts` | `number` | No       | `3`     | Maximum total attempts, including the initial request |
| `retry.delay`       | `number` | No       | `1000`  | Base delay in ms before the first retry             |
| `retry.factor`      | `number` | No       | `2`     | Exponential backoff factor (delay × factor^attempt) |
| `retry.maxRetryAfter` | `number` | No     | `60000` | Upper bound in ms for the wait honored from a 429 `Retry-After` header |

### Network Configuration

| Option                   | Type                     | Required | Default | Description                         |
| ------------------------ | ------------------------ | -------- | ------- | ----------------------------------- |
| `network.timeout`        | `number`                 | No       | `30000` | Header and body inactivity timeout for a single request in ms |
| `network.defaultHeaders` | `Record<string, string>` | No       | `{}`    | Headers to include in every request |
| `network.tls`            | `object`                 | No       | -       | TLS settings for this pool's connections (see below) |

#### TLS

Certificates and keys are passed as PEM **content**, never as file paths: read them yourself so your application stays in control of how they are loaded. Passing a path throws at construction time.

| Option                            | Type                                       | Required | Default | Description                                                         |
| --------------------------------- | ------------------------------------------ | -------- | ------- | ------------------------------------------------------------------- |
| `network.tls.ca`                  | `string \| Buffer \| Array<string\|Buffer>` | No       | -       | Additional CA certificate(s) trusted by this pool                    |
| `network.tls.cert`                | `string \| Buffer`                          | No       | -       | Client certificate for mutual TLS (requires `key`)                   |
| `network.tls.key`                 | `string \| Buffer`                          | No       | -       | Private key for mutual TLS (requires `cert`)                         |
| `network.tls.passphrase`          | `string`                                   | No       | -       | Passphrase decrypting an encrypted `key`                             |
| `network.tls.servername`          | `string`                                   | No       | -       | SNI hostname, when it differs from the host in `baseUrl`             |
| `network.tls.rejectUnauthorized`  | `boolean`                                  | No       | `true`  | Whether the server certificate must validate                         |

These settings apply **only to this pool**. The process-wide trust store is untouched, so every other connection your application makes keeps validating against the system CAs — unlike `NODE_EXTRA_CA_CERTS`, which widens trust for the whole process.

```ts
import { readFileSync } from "node:fs";

// An endpoint whose chain the system CA bundle cannot complete
const pool = new CallPool({
    baseUrl: "https://api.internal.example.com",
    network: {
        tls: { ca: readFileSync("./certs/internal-ca.pem", "utf8") },
    },
});

// Mutual TLS
const mtlsPool = new CallPool({
    baseUrl: "https://api.partner.example.com",
    network: {
        tls: {
            cert: readFileSync("./certs/client.crt", "utf8"),
            key: readFileSync("./certs/client.key", "utf8"),
            passphrase: process.env.CLIENT_KEY_PASSPHRASE,
        },
    },
});
```

> `rejectUnauthorized: false` disables certificate verification entirely and exposes the connection to interception. Use it only against a local or disposable environment, never to work around a chain that a proper `ca` would fix.

## Request

Options for individual requests passed to the `request()` method.

**Note**: Response parsing is automatic. If `Content-Type` contains `application/json`, the body is parsed as JSON. Textual media types and responses without `Content-Type` return a string; binary media types return a byte-preserving `Buffer`. Request bodies that are JavaScript objects are automatically serialized to JSON with the appropriate `Content-Type` header.

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
// Response JSON is automatically parsed when Content-Type is application/json
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
| `response`      | `"body" \| "raw"`                                  | No       | `"body"` | `"raw"` resolves with a `{ status, headers, body }` envelope    |
| `exposeCookies` | `boolean`                                          | No       | `false`  | Reveals `Set-Cookie` in the raw envelope (redacted by default)  |

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

## Introspection

-   `pool.getCurrentConcurrency()`: current concurrency limit (the live adaptive value when adaptive throttling is enabled)
-   `pool.getStats()`: live snapshot of the pool — `{ queued, running, concurrency }`

## Error Handling

-   **429 (Rate Limit)**: Automatically detects `Retry-After` header and waits exactly that long (capped at `retry.maxRetryAfter`, default 60s) before retrying — no extra backoff is stacked on top
-   **5xx (Server Error) and 408 (Request Timeout)**: Automatic retry with exponential backoff
-   **Other 4xx (Client Error)**: No retry is performed
-   **Network Error**: Automatic retry with exponential backoff
-   **Invalid local request arguments**: Propagated immediately without retry
-   **AbortSignal**: Pass a `signal` in the request options to cancel a request; an aborted request is never retried, and pending retry waits resolve immediately

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
        err.retryable; // whether the pool retried it
        err.retryAfterMs; // parsed Retry-After (429 only)
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
