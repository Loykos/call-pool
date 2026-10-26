import { Pool, ProxyAgent, errors } from "undici";
import type { NetworkOptions } from "../types.js";
import { validateNetwork } from "../validation.js";
import type { TransportFactory } from "./transport.js";

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
    validateNetwork(network);
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
