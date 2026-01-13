# CallPool

[![license](https://img.shields.io/npm/l/call-pool)](https://github.com/Loykos/call-pool/blob/main/LICENSE)

HTTP request pool with rate limiting, quotas, automatic retry, and adaptive throttling for Node.js.

## Why CallPool?

Managing thousands of requests against rate-limited APIs is hard. Native `fetch` or simple `undici` requests loops often lead to **429 errors**, **socket exhaustion**, or **local memory spikes**.

**CallPool orchestrates your outbound traffic**, giving you precise control over concurrency, quotas, throttling and retries in a single, ready-to-use tool.

The tool uses a **Real-Time Adaptive Throttling** feature (based on the **EMA algorithm**) that gives you the ability to detect upstream congestion and adjust the request rate in real-time to protect your throughput.

## Features

-   **HTTP Connection Pool**: Uses [`undici`](https://github.com/nodejs/undici) to efficiently manage TCP connections
-   **Rate Limiting**: Leverages [`bottleneck`](https://github.com/SGrondin/bottleneck) for precise quota management, supporting both fixed windows and "auto" distribution
-   **Adaptive Throttling**: Real-time latency monitoring. It automatically slows down when the upstream service starts to lag, preventing 429s and timeouts
-   **Automatic Retry**: Integrated with [`p-retry`](https://github.com/sindresorhus/p-retry) for exponential backoff, network and server errors, including `Retry-After` header support

## Installation

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
        congestionThreshold: 2.5, // Slow down if latency > 2.5x the average
    },
    retry: {
        maxAttempts: 5, // More attempts for external services
        delay: 2000, // 2 seconds initial wait
        factor: 2, // Exponential backoff: 2s, 4s, 8s, 16s, 32s
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
        congestionThreshold: 2.0, // Threshold for adaptive throttling
    },
    retry: {
        maxAttempts: 3, // Maximum 3 attempts
        delay: 1000, // 1 second initial delay
        factor: 2, // Backoff: 1s, 2s, 4s
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
    priority: 9, // High priority
});

const urgent = await pool.request("/urgent", {
    method: "GET",
    priority: 9,
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
| `concurrency.limit` | `number` | No       | `10`    | Maximum number of concurrent requests |

### Rate Limit Configuration

| Option                          | Type               | Required | Default | Description                                                                                   |
| ------------------------------- | ------------------ | -------- | ------- | --------------------------------------------------------------------------------------------- |
| `rateLimit.minTime`             | `number \| "auto"` | No       | `0`     | Minimum time between requests in ms, or `"auto"` for automatic calculation (requires `quota`) |
| `rateLimit.quota.max`           | `number`           | No       | -       | Maximum number of requests allowed in the time window                                         |
| `rateLimit.quota.window`        | `number`           | No       | -       | Time window in ms (e.g., 60000 for 1 minute)                                                  |
| `rateLimit.congestionThreshold` | `number`           | No       | `2.0`   | Threshold for adaptive throttling. If latency > average × threshold, the pool slows down      |

### Retry Configuration

| Option              | Type     | Required | Default | Description                                         |
| ------------------- | -------- | -------- | ------- | --------------------------------------------------- |
| `retry.maxAttempts` | `number` | No       | `3`     | Maximum number of retry attempts                    |
| `retry.delay`       | `number` | No       | `1000`  | Base delay in ms before the first retry             |
| `retry.factor`      | `number` | No       | `2`     | Exponential backoff factor (delay × factor^attempt) |

### Network Configuration

| Option                   | Type                     | Required | Default | Description                         |
| ------------------------ | ------------------------ | -------- | ------- | ----------------------------------- |
| `network.timeout`        | `number`                 | No       | `30000` | Timeout for single request in ms    |
| `network.defaultHeaders` | `Record<string, string>` | No       | `{}`    | Headers to include in every request |

## Request

Options for individual requests passed to the `request()` method.

**Note**: JSON parsing is automatic. If the response `Content-Type` header contains `application/json`, the response body is automatically parsed as JSON. Otherwise, it returns the raw text. Request bodies that are JavaScript objects are automatically serialized to JSON with the appropriate `Content-Type` header.

### Example

```typescript
const pool = new CallPool({
    baseUrl: "https://api.example.com",
});

// GET request with high priority
const data = await pool.request("/data", {
    priority: 9,
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

| Option     | Type                                               | Required | Default | Description                                                    |
| ---------- | -------------------------------------------------- | -------- | ------- | -------------------------------------------------------------- |
| `method`   | `HttpMethod`                                       | No       | `"GET"` | HTTP method (GET, POST, PUT, DELETE, etc.)                     |
| `priority` | `number`                                           | No       | `5`     | Queue priority (0-9, 9 is highest)                             |
| `body`     | `string \| Buffer \| Uint8Array \| object \| null` | No       | -       | Request body (JS objects are automatically serialized to JSON) |
| `headers`  | `Record<string, string>`                           | No       | -       | Additional headers for the single request                      |

## Adaptive Throttling

The pool automatically monitors request latency and slows down when congestion is detected:

-   Calculates an exponential moving average (EMA) of latency
-   If a request is slower than the average multiplied by `congestionThreshold`, it increases the delay
-   When requests become fast again, it restores the original delay

## Error Handling

-   **429 (Rate Limit)**: Automatically detects `Retry-After` header and waits
-   **5xx (Server Error)**: Automatic retry
-   **4xx (Client Error)**: No retry is performed (AbortError)
-   **Network Error**: Automatic retry

## Dependencies

-   `undici`: High-performance HTTP connection pool
-   `bottleneck`: Rate limiting and queue management
-   `p-retry`: Retry with exponential backoff

## License

MIT
