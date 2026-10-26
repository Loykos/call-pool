import { untilAborted } from "../abort.js";
import type { RetryContext, Transport, TransportFactory } from "./transport.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * What the pool sets on every attempt, on top of the environment's `RequestInit`
 * (Node's or DOM's), so the global `fetch` fits either way.
 * `FetchTransportOptions.init` adds a client's own extras.
 */
export interface FetchInit extends RequestInit {
    method: string;
    headers: Record<string, string>;
    /** Caller signal, `maxElapsedTime` and `RequestOptions.timeout` together. */
    signal: AbortSignal;
    redirect: "manual" | "follow" | "error";
    /**
     * `RequestOptions.timeout`, for clients that also bound the exchange natively
     * (impit): aborting their promise alone may leave the request running.
     * Standard fetch ignores it.
     */
    timeout?: number;
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
                    // A client build may stall (e.g. waiting for a proxy): the attempt's signal still settles it
                    const fetch = await untilAborted(client, attempt.signal);
                    const response = await fetch(url.href, {
                        ...init,
                        method,
                        headers,
                        body: (body ?? null) as FetchInit["body"],
                        signal: attempt.signal,
                        redirect,
                        ...(timeout === undefined ? {} : { timeout }),
                    });
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
            isFatal,
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeout !== undefined) {
        const expiresAt = performance.now() + timeout;
        const armTimer = () => {
            const remaining = expiresAt - performance.now();
            if (remaining <= 0) {
                controller.abort(new TransportTimeoutError(timeout));
                return;
            }
            // Node turns delays beyond this limit into 1 ms; keep the original deadline.
            timer = setTimeout(armTimer, Math.min(remaining, MAX_TIMER_DELAY_MS));
            timer.unref?.();
        };
        armTimer();
    }
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
