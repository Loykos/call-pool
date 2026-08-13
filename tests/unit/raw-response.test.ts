import { describe, it, expect } from "vitest";
import { CallPool, CallPoolError, CallPoolResponse } from "../../src/index";
import { MockServer } from "../setup/mock-server";

describe.concurrent("Raw Response Mode", () => {
    describe("Envelope shape", () => {
        it("should resolve with { status, headers, body } and a parsed JSON body", async () => {
            const mockServer = new MockServer();
            const data = { id: 42 };
            const baseUrl = await mockServer.start({
                headers: { "Content-Type": "application/json", "X-Request-Id": "abc" },
                body: data,
            });
            const pool = new CallPool({ baseUrl });

            try {
                const res: CallPoolResponse<typeof data> = await pool.request<typeof data>("/raw", { response: "raw" });
                expect(res.status).toBe(200);
                expect(res.headers["x-request-id"]).toBe("abc");
                expect(res.body).toEqual(data);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should keep returning the bare body in default mode", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({ body: { ok: true } });
            const pool = new CallPool({ baseUrl });

            try {
                const result = await pool.request<{ ok: boolean }>("/default");
                expect(result).toEqual({ ok: true });
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should expose 3xx responses without throwing (redirects are not followed)", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                statusCode: 302,
                headers: { "Content-Type": "text/plain", Location: "/next-hop" },
                body: "",
            });
            const pool = new CallPool({ baseUrl });

            try {
                const res = await pool.request("/login", { response: "raw" });
                expect(res.status).toBe(302);
                expect(res.headers["location"]).toBe("/next-hop");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should still reject with CallPoolError on 4xx", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({ statusCode: 404, body: "not found" });
            const pool = new CallPool({ baseUrl });

            try {
                await expect(pool.request("/missing", { response: "raw" })).rejects.toThrowError(CallPoolError);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });
    });

    describe("Set-Cookie redaction", () => {
        it("should redact Set-Cookie in the raw envelope by default", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                headers: { "Content-Type": "application/json", "Set-Cookie": "sid=secret123; Path=/" },
                body: { ok: true },
            });
            const pool = new CallPool({ baseUrl });

            try {
                const res = await pool.request("/session", { response: "raw" });
                expect(res.headers["set-cookie"]).toBe("[redacted]");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should expose Set-Cookie when exposeCookies is true", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                headers: { "Content-Type": "application/json", "Set-Cookie": "sid=secret123; Path=/" },
                body: { ok: true },
            });
            const pool = new CallPool({ baseUrl });

            try {
                const res = await pool.request("/session", { response: "raw", exposeCookies: true });
                expect(res.headers["set-cookie"]).toContain("sid=secret123");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should keep CallPoolError headers redacted even with exposeCookies", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                statusCode: 403,
                headers: { "Content-Type": "text/plain", "Set-Cookie": "sid=secret123; Path=/" },
                body: "forbidden",
            });
            const pool = new CallPool({ baseUrl });

            try {
                const error = await pool
                    .request("/forbidden", { response: "raw", exposeCookies: true })
                    .then(() => null, (err: unknown) => err);
                expect(error).toBeInstanceOf(CallPoolError);
                expect((error as CallPoolError).headers?.["set-cookie"]).toBe("[redacted]");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });
    });
});
