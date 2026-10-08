import { describe, it, expect } from "vitest";
import { CallPool, type CallPoolOptions } from "../../src/index";

describe("0.8 configuration migration guards", () => {
    it.each(["tls", "proxy", "timeout", "defaultHeaders"])("rejects removed network.%s for JavaScript callers", key => {
        expect(() => new CallPool({ baseUrl: "http://localhost", network: { [key]: {} } } as CallPoolOptions))
            .toThrow(`'network.${key}' was removed in 0.8`);
    });

    it("rejects the previous deadline placement", () => {
        expect(() => new CallPool({ baseUrl: "http://localhost", retry: { maxElapsedTime: 1000 } } as CallPoolOptions))
            .toThrow("'retry.maxElapsedTime' moved to 'maxElapsedTime'");
    });

    it("rejects the previous adaptive pause control", () => {
        expect(() => new CallPool({ baseUrl: "http://localhost", adaptive: { rateLimitSignal: { pause: false } } } as CallPoolOptions))
            .toThrow("'adaptive.rateLimitSignal.pause' moved to 'retry.pauseCodes'");
    });
});
