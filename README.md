# CallPool

HTTP request pool with rate limiting, quotas, automatic retry, and adaptive throttling for Node.js.

## Features

-   **HTTP Connection Pool**: Uses `undici` to efficiently manage TCP connections
-   **Rate Limiting**: Configurable with quotas and time windows
-   **Adaptive Throttling**: Automatically slows down when congestion is detected
-   **Automatic Retry**: Retry with exponential backoff for network and server errors
-   **Request Priority**: Queue system with priority levels (0-9)
-   **TypeScript**: Fully typed

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
const users = await pool.request<User[]>("/users");

const newUser = await pool.request<User>("/users", {
    method: "POST",
    body: { name: "John", email: "john@example.com" },
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

## Basic Usage

```typescript
import { CallPool } from "call-pool";

const pool = new CallPool({
    baseUrl: "https://api.example.com",
    concurrency: {
        limit: 10,
    },
    rateLimit: {
        minTime: "auto",
        quota: {
            max: 100,
            window: 60000, // 100 requests per minute
        },
    },
    retry: {
        maxAttempts: 3,
        delay: 1000,
        factor: 2,
    },
    network: {
        timeout: 30000,
        defaultHeaders: {
            Authorization: "Bearer token",
        },
    },
});

// GET request
const users = await pool.request<User[]>("/users");

// POST request
const newUser = await pool.request<User>("/users", {
    method: "POST",
    body: { name: "John", email: "john@example.com" },
});

// High priority request
const urgent = await pool.request("/urgent", {
    priority: 9,
});

// Close the pool when done
await pool.close();
```

## Configuration

### CallPoolOptions

-   `baseUrl` (required): Base URL for all requests
-   `concurrency.limit`: Maximum number of concurrent requests (default: 10)
-   `rateLimit.minTime`: Minimum time between requests in ms, or `"auto"` for automatic calculation
-   `rateLimit.quota`: Contractual quota (e.g., 100 requests per minute)
-   `rateLimit.congestionThreshold`: Threshold for adaptive throttling (default: 2.0)
-   `retry.maxAttempts`: Maximum number of attempts (default: 3)
-   `retry.delay`: Base delay for retry in ms (default: 1000)
-   `retry.factor`: Exponential backoff factor (default: 2)
-   `network.timeout`: Timeout for single request in ms (default: 30000)
-   `network.defaultHeaders`: Headers to include in every request

### RequestOptions

-   `method`: HTTP method (GET, POST, PUT, DELETE, etc.)
-   `priority`: Queue priority (0-9, default: 5, 9 is highest)
-   `body`: Request body (can be a JS object, will be automatically serialized)
-   `headers`: Additional headers for the single request

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
