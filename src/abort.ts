/**
 * `value`, or the signal's reason as soon as it aborts. For waits the pool
 * cannot cancel (a client build, a rotation): they keep running, but no longer
 * hold the request, its scheduler slot or `close()`.
 */
export function untilAborted<T>(value: T | Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return Promise.resolve(value);
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve(value)
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", onAbort));
    });
}
