import type { NamedStatus, StatusCodeSelector } from "./types.js";

/** Lowercase, starts with a letter: never confused with a code or "4xx"/"5xx". */
export function isNamedStatus(value: unknown): value is NamedStatus {
    return typeof value === "string" && /^[a-z][a-z0-9_-]*$/.test(value);
}

/** A resolved status is a number or a name; a name only matches itself. */
export function matchesCode(code: number | string, selectors: readonly StatusCodeSelector[]): boolean {
    if (typeof code === "string") return selectors.includes(code as StatusCodeSelector);
    return selectors.some(selector => selector === code || (selector === "4xx" && code >= 400 && code < 500) || (selector === "5xx" && code >= 500 && code < 600));
}

/** Parse separately for each policy: retry and breaker have independent caps. */
export function parseRetryAfter(value: string | string[] | undefined, maximum: number): number | undefined {
    const text = (Array.isArray(value) ? value[0] : value)?.trim();
    if (!text) return undefined;
    if (/^\d+(?:\.\d+)?$/.test(text)) {
        const seconds = Number(text);
        if (Number.isFinite(seconds)) return Math.min(seconds * 1000, maximum);
    }
    // Negative/invalid numeric strings must not parse as historical dates.
    if (!/[a-z]/i.test(text)) return undefined;
    const at = Date.parse(text);
    return Number.isFinite(at) ? Math.min(Math.max(0, at - Date.now()), maximum) : undefined;
}
