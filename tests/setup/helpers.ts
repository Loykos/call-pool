/**
 * Utility functions per i test
 */

export function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function waitFor(condition: () => boolean, timeout: number = 5000, interval: number = 100): Promise<void> {
    return new Promise((resolve, reject) => {
        const start = Date.now();

        const check = () => {
            if (condition()) {
                resolve();
            } else if (Date.now() - start > timeout) {
                reject(new Error(`Timeout waiting for condition after ${timeout}ms`));
            } else {
                setTimeout(check, interval);
            }
        };

        check();
    });
}

export function expectTiming(actual: number, expected: number, tolerance: number = 100): void {
    const diff = Math.abs(actual - expected);
    if (diff > tolerance) {
        throw new Error(`Timing mismatch: expected ~${expected}ms, got ${actual}ms (diff: ${diff}ms)`);
    }
}

export function createMockResponse(
    body: any,
    statusCode: number = 200,
    headers: Record<string, string> = {}
): { body: any; statusCode: number; headers: Record<string, string> } {
    return {
        body: typeof body === "string" ? body : JSON.stringify(body),
        statusCode,
        headers: {
            "Content-Type": "application/json",
            ...headers,
        },
    };
}
