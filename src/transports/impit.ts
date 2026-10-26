import { Impit, type HttpMethod, type ImpitOptions, type ImpitResponse, type RequestInit } from "impit";
import { fetchTransport, type FetchLike, type FetchTransportOptions } from "./fetch.js";
import type { TransportFactory } from "./transport.js";

/**
 * impit errors a retry cannot fix: a malformed request, a refused proxy login,
 * misuse of a body. Timeouts, network, remote protocol and proxy tunnel errors
 * are retried, on a new client when the transport rotates.
 */
const FATAL_ERRORS = new Set([
    "InvalidURL",
    "UnsupportedProtocol",
    "LocalProtocolError",
    "ProxyAuthRequired",
    "CookieConflict",
    "StreamError",
    "StreamConsumed",
    "ResponseNotRead",
    "RequestNotRead",
    "StreamClosed",
]);

/**
 * Native bound of every exchange, as Undici's 30 s header and body timeouts:
 * impit has none, and cannot stop a request before its headers.
 * `RequestOptions.timeout` overrides it per attempt.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ImpitTransportOptions extends Omit<ImpitOptions, "proxyUrl"> {
    /** Fixed proxy, or a factory called for the first client and again at every rotation. Undefined: direct. */
    proxyUrl?: string | (() => string | undefined | Promise<string | undefined>);
    /** Which retries build a new client (new TLS session and, with a proxy factory, a new proxy). Default: every retry. */
    rotateOn?: FetchTransportOptions["rotateOn"];
    /** Extra init fields for every request (e.g. `forceHttp3`). */
    init?: FetchTransportOptions["init"];
}

/** Whether `error` is an impit error a retry cannot fix. */
export function isImpitFatal(error: unknown): boolean {
    return error instanceof Error && FATAL_ERRORS.has(error.name);
}

/**
 * Sends requests with impit, which impersonates a browser's TLS and HTTP/2
 * fingerprint (`browser: "chrome"`, `"firefox"`, …). Redirects reach
 * the pool as responses, like with the Undici transport.
 */
export function impitTransport({ proxyUrl, rotateOn, init, timeout = DEFAULT_TIMEOUT_MS, ...impit }: ImpitTransportOptions = {}): TransportFactory {
    return fetchTransport(
        {
            async create(): Promise<FetchLike> {
                const client = new Impit({ ...impit, timeout, proxyUrl: typeof proxyUrl === "function" ? await proxyUrl() : proxyUrl });
                // impit types the method and the body with its own unions, and takes no null body
                return (url, { method, body, signal, ...rest }) => exchange(client, url, { ...(rest as RequestInit), method: method as HttpMethod, body: (body ?? undefined) as RequestInit["body"] }, signal);
            },
        },
        { init, rotateOn, isFatal: isImpitFatal },
    );
}

/**
 * Settles when the exchange ends, so the pool holds its slot until then: an
 * abort before the headers only settles impit's promise while the native request
 * runs on, so impit gets the abort once the headers are in, where it stops the body.
 */
async function exchange(client: Impit, url: string, init: RequestInit, signal: AbortSignal): Promise<ImpitResponse> {
    const body = new AbortController();
    let response: ImpitResponse;
    try {
        response = await client.fetch(url, { ...init, signal: body.signal });
    } catch (error) {
        signal.throwIfAborted();
        throw error;
    }
    const forward = () => body.abort(signal.reason);
    if (signal.aborted) forward();
    else signal.addEventListener("abort", forward, { once: true });
    signal.throwIfAborted();
    return response;
}
