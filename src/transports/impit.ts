import { Impit, type HttpMethod, type ImpitOptions, type RequestInit } from "impit";
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
export function impitTransport({ proxyUrl, rotateOn, init, ...impit }: ImpitTransportOptions = {}): TransportFactory {
    return fetchTransport(
        {
            async create(): Promise<FetchLike> {
                const client = new Impit({ ...impit, proxyUrl: typeof proxyUrl === "function" ? await proxyUrl() : proxyUrl });
                // impit types the method as its own union and takes no null body
                return (url, { method, body, ...rest }) => client.fetch(url, { ...(rest as RequestInit), method: method as HttpMethod, body: body ?? undefined });
            },
        },
        { init, rotateOn, isFatal: isImpitFatal },
    );
}
