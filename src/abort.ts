/**
 * `value`, or the signal's reason as soon as it aborts, for waits the pool
 * cannot cancel. The wait runs on: a stalled client build or rotation no longer
 * holds the request, its slot or `close()`; a job keeps its slot until it settles.
 */
export function untilAborted<T>(value: T | Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return Promise.resolve(value);
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        // Observed even after the abort: a late rejection is never unhandled
        Promise.resolve(value)
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", onAbort));
    });
}
