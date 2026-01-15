import { describe, it, expect } from "vitest";
import { CallPool } from "../../src/index";
import { MockServer } from "../setup/mock-server";

describe.concurrent("Parsing Logic", () => {
    describe("JSON Parsing", () => {
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
    });

    describe("Edge Cases & Empty Bodies", () => {
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

        it("should throw a parsing error when JSON is expected but body is invalid/empty", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                headers: { "Content-Type": "application/json" },
                body: "not-a-json",
            });
            const pool = new CallPool({ baseUrl });

            try {
                // response.body.json() fallirà internamente
                await expect(pool.request("/invalid-json")).rejects.toThrow();
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
                // Test puramente a tempo di compilazione/esecuzione per i generics
                const result = await pool.request<User>("/user");
                expect(result.id).toBe(10);
                expect(result.username).toBe("dev_user");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });
    });
});
