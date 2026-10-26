import { Pool, ProxyAgent, errors, type Dispatcher } from "undici";
import type { NetworkOptions } from "./types.js";

/** One HTTP attempt, as the pool hands it to the transport. */
export interface TransportRequest {
    /** The path as given to `request()`, for clients bound to the origin (Undici's Pool). */
    path: string;
    /** `path` resolved against the origin of `baseUrl`, for clients that take a full URL. */
    url: URL;
    method: Dispatcher.HttpMethod;
    /** Pool `defaultHeaders` merged with the request's, lowercase names (request wins). */
    headers: Record<string, string>;
    /** Already serialized: object bodies become JSON before reaching the transport. */
    body?: string | Buffer | Uint8Array | null;
    /** Caller signal joined with `maxElapsedTime`: aborts the exchange and the body download. */
    signal?: AbortSignal;
    /** `RequestOptions.timeout`: budget of this attempt in ms; undefined keeps the transport's default. */
    timeout?: number;
    /** The rest of RequestOptions (Undici Dispatcher passthrough): a transport reads only what it knows. */
    options: Record<string, unknown>;
}

/**
 * Resolves once status and headers are in: the pool samples TTFB here, the
 * body is read on demand, once. Same shape as Undici's `Dispatcher.ResponseData`.
 */
export interface TransportResponse {
    statusCode: number;
    /** Lowercase names; repeated headers (set-cookie) as arrays. */
    headers: Record<string, string | string[] | undefined>;
    body: {
        text(): Promise<string>;
        arrayBuffer(): Promise<ArrayBuffer>;
    };
}

/** The attempt that just failed, handed to `Transport.rotate` before the pool retries it. */
export interface RetryContext {
    /** 1-based number of the failed attempt. */
    attempt: number;
    /** HTTP or resolved status (403, "blocked"); undefined for a transport error. */
    status?: number | string;
    error: unknown;
}

/** How requests reach the host: the pool decides when and how many, the transport how. */
export interface Transport {
    request(request: TransportRequest): Promise<TransportResponse>;
    /** Before every retry: a new client, proxy session or IP. Concurrent failures may call it together. */
    rotate?(context: RetryContext): void | Promise<void>;
    /** Transport errors a retry cannot fix (invalid arguments, closed client). Default: none. */
    isFatal?(error: unknown): boolean;
    /** Releases sockets and clients once the pool has drained. */
    close(): Promise<void>;
}

/** What the pool tells a transport when it builds it. */
export interface TransportContext {
    /** Origin of `baseUrl`. */
    origin: string;
    /** `concurrency.limit`: the connections a pooled client needs to serve every slot. */
    connections: number;
}

/** Builds the pool's transport; the pool owns its lifecycle and closes it in `close()`. */
export type TransportFactory = (context: TransportContext) => Transport;

export interface UndiciTransportOptions {
    /** Native Undici Pool.Options or ProxyAgent.Options (`uri` selects ProxyAgent), overriding pool defaults. */
    network?: NetworkOptions;
}

/**
 * The default transport: an Undici `Pool` bound to the origin, or a `ProxyAgent`
 * when `network.uri` is set. `timeout` becomes `headersTimeout` and
 * `bodyTimeout` unless the request sets them itself.
 */
export function undiciTransport({ network }: UndiciTransportOptions = {}): TransportFactory {
    return ({ origin, connections }) => {
        const defaults = { connections, pipelining: 1, keepAliveTimeout: 10_000, headersTimeout: 30_000, bodyTimeout: 30_000 };
        const proxied = network !== undefined && "uri" in network && network.uri !== undefined;
        const client = proxied ? new ProxyAgent({ ...defaults, ...network }) : new Pool(origin, { ...defaults, ...network });

        return {
            request: ({ path, method, headers, body, signal, timeout, options }) =>
                client.request({
                    ...(timeout === undefined ? {} : { headersTimeout: timeout, bodyTimeout: timeout }),
                    ...options,
                    // A Pool is bound to its origin; a ProxyAgent is origin-agnostic
                    // and must be told the tunnel target on every request.
                    ...(proxied ? { origin } : {}),
                    path,
                    method,
                    headers,
                    body: body ?? null,
                    signal,
                }),
            isFatal: error =>
                error instanceof errors.InvalidArgumentError ||
                error instanceof errors.InvalidReturnValueError ||
                error instanceof errors.RequestAbortedError,
            close: () => client.close(),
        };
    };
}
