import { describe, it, expect } from "vitest";
import { CallPool, CallPoolError } from "../../src/index";
import { MockServer } from "../setup/mock-server";

describe.concurrent("Parsing Logic", () => {
    describe("JSON Parsing", () => {
        it.each([
            "Application/JSON",
            "APPLICATION/JSON; charset=UTF-8",
            "application/vnd.api+json",
            "Application/Problem+JSON ; charset=utf-8",
        ])("should parse %s consistently in body and raw modes", async contentType => {
            const mockServer = new MockServer();
            const data = { ok: true };
            const baseUrl = await mockServer.start({ headers: { "Content-Type": contentType }, body: data });
            const pool = new CallPool({ baseUrl });
            try {
                await expect(pool.request("/body")).resolves.toEqual(data);
                const raw = await pool.request("/raw", { response: "raw" });
                expect(raw.body).toEqual(data);
                expect(raw.headers["content-type"]).toBe(contentType);
                // An explicit byte request must still bypass JSON decoding.
                await expect(pool.request("/bytes", { binary: true })).resolves.toEqual(Buffer.from(JSON.stringify(data)));
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should automatically parse JSON objects and arrays", async () => {
            const mockServer = new MockServer();
            const data = { id: 1, tags: ["api", "test"] };
            const baseUrl = await mockServer.start({
                headers: { "Content-Type": "application/json" },
                body: data,
            });
            const pool = new CallPool({ baseUrl });

            try {
                const result = await pool.request<typeof data>("/json");
                expect(result).toEqual(data);
                expect(result.tags).toContain("api");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should handle Content-Type with charset (e.g., utf-8)", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                headers: { "Content-Type": "application/json; charset=utf-8" },
                body: { status: "ok" },
            });
            const pool = new CallPool({ baseUrl });

            try {
                const result = await pool.request<{ status: string }>("/charset");
                expect(result.status).toBe("ok");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should parse deeply nested JSON structures", async () => {
            const mockServer = new MockServer();
            const nested = { a: { b: { c: 42 } } };
            const baseUrl = await mockServer.start({
                headers: { "Content-Type": "application/json" },
                body: nested,
            });
            const pool = new CallPool({ baseUrl });

            try {
                const result = await pool.request<typeof nested>("/nested");
                expect(result.a.b.c).toBe(42);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });
    });

    describe("Text & Fallback Parsing", () => {
        it.each([
            { contentType: 'text/plain; profile="application/json"', binary: false },
            { contentType: "application/json-seq", binary: true },
            { contentType: "Application/Atom+XML; charset=utf-8", binary: false },
        ])("should classify only the media type: $contentType", async ({ contentType, binary }) => {
            const mockServer = new MockServer();
            const payload = "not JSON";
            const baseUrl = await mockServer.start({ headers: { "Content-Type": contentType }, body: payload });
            const pool = new CallPool({ baseUrl });
            try {
                await expect(pool.request("/content")).resolves.toEqual(binary ? Buffer.from(payload) : payload);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should return raw text when Content-Type is not JSON (text/plain, text/html)", async () => {
            const mockServer = new MockServer();
            const html = "<html><body>Hi</body></html>";
            const baseUrl = await mockServer.start({
                headers: { "Content-Type": "text/html" },
                body: html,
            });
            const pool = new CallPool({ baseUrl });

            try {
                const result = await pool.request<string>("/html");
                expect(result).toBe(html);
                expect(typeof result).toBe("string");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should return raw text when Content-Type header is missing", async () => {
            const mockServer = new MockServer();
            const rawData = "some random data";
            const baseUrl = await mockServer.start({
                headers: {}, // Niente headers
                body: rawData,
            });
            const pool = new CallPool({ baseUrl });

            try {
                const result = await pool.request<string>("/no-header");
                expect(result).toBe(rawData);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should preserve binary response bytes", async () => {
            const mockServer = new MockServer();
            const payload = Buffer.from([0x00, 0xff, 0x80, 0xc3, 0x28, 0x41]);
            const baseUrl = await mockServer.start({
                headers: { "Content-Type": "application/octet-stream" },
                body: payload,
            });
            const pool = new CallPool({ baseUrl });

            try {
                const result = await pool.request<Buffer>("/binary");
                expect(Buffer.isBuffer(result)).toBe(true);
                expect(result.toString("hex")).toBe("00ff80c32841");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });
    });

    describe("Binary Opt-In", () => {
        const payload = Buffer.from([0x00, 0xff, 0x80, 0xc3, 0x28, 0x41]);

        it("should preserve bytes when the response carries no Content-Type", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({ headers: {}, body: payload });
            const pool = new CallPool({ baseUrl });

            try {
                const result = await pool.request<Buffer>("/no-content-type", { binary: true });
                expect(Buffer.isBuffer(result)).toBe(true);
                expect(result.toString("hex")).toBe("00ff80c32841");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should keep decoding a Content-Type-less response as text by default", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({ headers: {}, body: "plain" });
            const pool = new CallPool({ baseUrl });

            try {
                expect(await pool.request("/default")).toBe("plain");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should preserve bytes a textual Content-Type would have decoded", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                headers: { "Content-Type": "text/html" },
                body: payload,
            });
            const pool = new CallPool({ baseUrl });

            try {
                const result = await pool.request<Buffer>("/mislabelled", { binary: true });
                expect(result.toString("hex")).toBe("00ff80c32841");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should not parse JSON when the caller asked for bytes", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                headers: { "Content-Type": "application/json" },
                body: { status: "ok" },
            });
            const pool = new CallPool({ baseUrl });

            try {
                const result = await pool.request<Buffer>("/json-as-bytes", { binary: true });
                expect(Buffer.isBuffer(result)).toBe(true);
                expect(JSON.parse(result.toString("utf8"))).toEqual({ status: "ok" });
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should keep an error body readable", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                statusCode: 404,
                headers: {},
                body: "not found here",
            });
            const pool = new CallPool({ baseUrl });

            try {
                await expect(pool.request("/missing", { binary: true })).rejects.toThrow("not found here");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should not forward the flag to the transport as a request option", async () => {
            const mockServer = new MockServer();
            let seen: Record<string, string> = {};
            const baseUrl = await mockServer.start({
                headers: {},
                body: payload,
                onRequestStart: req => {
                    seen = req.headers;
                },
            });
            const pool = new CallPool({ baseUrl });

            try {
                await pool.request<Buffer>("/clean", { binary: true });
                expect(seen).not.toHaveProperty("binary");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });
    });

    describe("Edge Cases & Empty Bodies", () => {
        it.each([
            { method: "GET", statusCode: 204 },
            { method: "GET", statusCode: 205 },
            { method: "GET", statusCode: 304 },
            { method: "HEAD", statusCode: 200 },
        ] as const)("should accept an empty $method response with status $statusCode", async ({ method, statusCode }) => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                statusCode,
                headers: { "Content-Type": "application/json", "X-Request-Id": "empty" },
                body: "",
            });
            const pool = new CallPool({ baseUrl });
            try {
                await expect(pool.request<void>("/empty", { method })).resolves.toBeUndefined();
                const raw = await pool.request<void>("/empty", { method, response: "raw" });
                expect(raw.status).toBe(statusCode);
                expect(raw.headers["x-request-id"]).toBe("empty");
                expect(raw).toHaveProperty("body", undefined);
                await expect(pool.request<Buffer>("/empty", { method, binary: true })).resolves.toEqual(Buffer.alloc(0));
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it.each(["application/octet-stream", "text/plain", undefined])("should return undefined for 204 with %s", async contentType => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                statusCode: 204,
                headers: contentType ? { "Content-Type": contentType } : {},
                body: "",
            });
            const pool = new CallPool({ baseUrl });
            try {
                await expect(pool.request("/empty")).resolves.toBeUndefined();
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should keep HEAD HTTP errors as errors", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({ statusCode: 404, body: "" });
            const pool = new CallPool({ baseUrl });
            try {
                await expect(pool.request("/missing", { method: "HEAD" })).rejects.toMatchObject({
                    statusCode: 404, body: "", retryable: false,
                });
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should keep vendor JSON HTTP errors textual and sanitized", async () => {
            const mockServer = new MockServer();
            const body = '{"detail":"missing"}';
            const baseUrl = await mockServer.start({
                statusCode: 404,
                headers: { "Content-Type": "application/problem+json", "Set-Cookie": "sid=secret" },
                body,
            });
            const pool = new CallPool({ baseUrl });
            try {
                await expect(pool.request("/missing", { binary: true, response: "raw", exposeCookies: true })).rejects.toMatchObject({
                    statusCode: 404, body, retryable: false, headers: { "set-cookie": "[redacted]" },
                });
                expect(mockServer.getRequestCount()).toBe(1);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should handle empty JSON objects", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                headers: { "Content-Type": "application/json" },
                body: {},
            });
            const pool = new CallPool({ baseUrl });

            try {
                const result = await pool.request("/empty-obj");
                expect(result).toEqual({});
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it.each([
            { contentType: "application/json", body: "not-a-json" },
            { contentType: "application/json", body: "" },
            { contentType: "application/vnd.api+json", body: "not-a-json" },
            { contentType: "Application/JSON", body: "" },
        ])("should reject invalid JSON on 200: $contentType, '$body'", async ({ contentType, body }) => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                headers: { "Content-Type": contentType },
                body,
            });
            const pool = new CallPool({ baseUrl });

            try {
                const error = await pool.request("/invalid-json").catch(error => error);
                expect(error).toBeInstanceOf(CallPoolError);
                expect(error).toMatchObject({ message: "Invalid JSON response", statusCode: 200, body, retryable: false });
                expect(mockServer.getRequestCount()).toBe(1);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should handle empty text responses gracefully", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                headers: { "Content-Type": "text/plain" },
                body: "",
            });
            const pool = new CallPool({ baseUrl });

            try {
                const result = await pool.request<string>("/empty-text");
                expect(result).toBe("");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });
    });

    describe("TypeScript Integration", () => {
        it("should correctly infer types through generics", async () => {
            const mockServer = new MockServer();
            interface User {
                id: number;
                username: string;
            }

            const baseUrl = await mockServer.start({
                headers: { "Content-Type": "application/json" },
                body: { id: 10, username: "dev_user" },
            });
            const pool = new CallPool({ baseUrl });

            try {
                // Purely compile-time/runtime test for generics
                const result = await pool.request<User>("/user");
                expect(result.id).toBe(10);
                expect(result.username).toBe("dev_user");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });
    });
});
