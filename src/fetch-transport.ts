import type { RetryContext, Transport, TransportFactory } from "./transport.js";

/** What the pool sets on every attempt; `FetchTransportOptions.init` adds a client's own extras. */
export interface FetchInit {
    method: string;
    headers: Record<string, string>;
    body: string | Uint8Array | null;
    /** Caller signal, `maxElapsedTime` and `RequestOptions.timeout` together. */
    signal: AbortSignal;
    redirect: "manual" | "follow" | "error";
    [option: string]: unknown;
}

/** The part of a Fetch `Headers` the pool reads. */
export interface HeadersLike {
    forEach(callback: (value: string, name: string) => void): void;
    getSetCookie?(): string[];
}

/** The part of a Fetch `Response` the pool reads: a WHATWG Response and impit's ImpitResponse both fit. */
export interface FetchResponseLike {
    status: number;
    headers: HeadersLike;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
}

/** Any client that speaks the Fetch API: globalThis.fetch, undici.fetch, impit's `fetch`, … */
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

/**
 * Builds the client, at start and again at every rotation: for clients bound to
 * a proxy or a TLS session when they are created (impit with `proxyUrl`).
 */
export interface FetchFactory {
    create(): FetchLike | Promise<FetchLike>;
}

export interface FetchTransportOptions {
    /** Extra init fields for every request, for options of the client (e.g. impit's `forceHttp3`). */
    init?: Record<string, unknown>;
    /** Default "manual": redirects reach the pool as responses, like with the Undici transport. */
    redirect?: FetchInit["redirect"];
    /** With a FetchFactory, which retries build a new client. Default: every retry. */
    rotateOn?(context: RetryContext): boolean;
    /** Client errors a retry cannot fix. Default: none, transport errors are retried. */
    isFatal?(error: unknown): boolean;
    /** Releases the client's resources when the pool closes. */
    close?(): void | Promise<void>;
}

/** `RequestOptions.timeout` elapsed before the response was read. */
export class TransportTimeoutError extends Error {
    constructor(readonly timeout: number) {
        super(`[CallPool] attempt timed out after ${timeout}ms`);
        this.name = "TransportTimeoutError";
    }
}

/**
 * Adapts a Fetch API client to the pool. A plain function is used as is; a
 * {@link FetchFactory} is called at start and again before the retries
 * `rotateOn` selects. Redirects are not followed unless `redirect` says so.
 */
export function fetchTransport(source: FetchLike | FetchFactory, options: FetchTransportOptions = {}): TransportFactory {
    const { init, redirect = "manual", rotateOn = () => true, isFatal, close } = options;
    return (): Transport => {
        const factory = typeof source === "function" ? undefined : source;
        let client = factory ? build(factory) : Promise.resolve(source as FetchLike);

        return {
            async request({ url, method, headers, body, signal, timeout }) {
                const attempt = attemptSignal(signal, timeout);
                try {
                    const fetch = await client;
                    const response = await fetch(url.href, { ...init, method, headers, body: body ?? null, signal: attempt.signal, redirect });
                    return {
                        statusCode: response.status,
                        headers: headerRecord(response.headers),
                        body: {
                            text: () => response.text().finally(attempt.dispose),
                            arrayBuffer: () => response.arrayBuffer().finally(attempt.dispose),
                        },
                    };
                } catch (error) {
                    attempt.dispose();
                    throw error;
                }
            },
            rotate: factory
                ? context => {
                    if (rotateOn(context)) client = build(factory);
                }
                : undefined,
            // A path that is no URL fails the same way on every attempt
            isFatal: error => (error as { code?: unknown })?.code === "ERR_INVALID_URL" || (isFatal?.(error) ?? false),
            close: async () => {
                await close?.();
            },
        };
    };
}

/** A new client; a failed build rejects the requests that await it, never the process. */
function build(factory: FetchFactory): Promise<FetchLike> {
    const client = Promise.resolve().then(() => factory.create());
    client.catch(() => undefined);
    return client;
}

/** The caller signal joined with the attempt timeout; `dispose` drops the timer and the listener. */
function attemptSignal(signal: AbortSignal | undefined, timeout: number | undefined): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const forward = () => controller.abort(signal?.reason);
    if (signal?.aborted) forward();
    signal?.addEventListener("abort", forward, { once: true });
    const timer = timeout === undefined ? undefined : setTimeout(() => controller.abort(new TransportTimeoutError(timeout)), timeout);
    timer?.unref?.();
    return {
        signal: controller.signal,
        dispose: () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", forward);
        },
    };
}

/** Lowercase names, Set-Cookie as an array like Undici's headers. */
function headerRecord(headers: HeadersLike): Record<string, string | string[] | undefined> {
    const record: Record<string, string | string[] | undefined> = {};
    headers.forEach((value, name) => {
        record[name.toLowerCase()] = value;
    });
    const cookies = headers.getSetCookie?.() ?? [];
    if (cookies.length > 0) record["set-cookie"] = cookies;
    return record;
}
