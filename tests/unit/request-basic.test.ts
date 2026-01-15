import { describe, it, expect } from "vitest";
import { CallPool } from "../../src/index";
import { MockServer } from "../setup/mock-server";

describe.concurrent("Request Basic", () => {
    describe("HTTP Methods & Basics", () => {
        it("should make a standard GET request and parse response", async () => {
            const mockServer = new MockServer();
            const responseData = { success: true };
            const baseUrl = await mockServer.start({
                body: JSON.stringify(responseData),
                headers: { "Content-Type": "application/json" },
            });
            const pool = new CallPool({ baseUrl });

            try {
                const result = await pool.request("/test");
                expect(result).toEqual(responseData);

                const requests = mockServer.getRequests();
                expect(requests[0].method).toBe("GET");
                expect(requests[0].path).toBe("/test");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should make POST, PUT, DELETE, PATCH requests correctly", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start();
            const pool = new CallPool({ baseUrl });

            try {
                const methods = ["POST", "PUT", "DELETE", "PATCH"] as const;
                for (const method of methods) {
                    await pool.request("/test", { method });
                }

                const requests = mockServer.getRequests();
                methods.forEach((method, index) => {
                    expect(requests[index].method).toBe(method);
                });
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });
    });

    describe("Body Serialization", () => {
        it("should serialize object body to JSON and set content-type", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start();
            const pool = new CallPool({ baseUrl });
            const body = { title: "Hello", id: 1 };

            try {
                await pool.request("/json", { method: "POST", body });

                const requests = mockServer.getRequests();
                expect(requests[0].body).toBe(JSON.stringify(body));
                expect(requests[0].headers["content-type"]).toBe("application/json");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should handle Buffer and Uint8Array without stringifying", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start();
            const pool = new CallPool({ baseUrl });
            const bufferBody = Buffer.from("raw-data");
            const uint8Body = new Uint8Array([1, 2, 3]);

            try {
                await pool.request("/buffer", { method: "POST", body: bufferBody });
                await pool.request("/uint8", { method: "POST", body: uint8Body });

                const requests = mockServer.getRequests();
                // Verifichiamo che i dati arrivino integri (come stringa nel mock server)
                expect(requests[0].body).toBe("raw-data");
                expect(requests[1].body).toBe(Buffer.from(uint8Body).toString());
                // Non deve esserci il content-type json
                expect(requests[0].headers["content-type"]).not.toBe("application/json");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should handle null or empty body", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start();
            const pool = new CallPool({ baseUrl });

            try {
                await pool.request("/null", { method: "POST", body: null });
                await pool.request("/empty", { method: "POST" });

                const requests = mockServer.getRequests();
                expect(requests[0].body).toBeUndefined();
                expect(requests[1].body).toBeUndefined();
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });
    });

    describe("Headers Management", () => {
        it("should merge and override headers correctly", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start();
            const pool = new CallPool({
                baseUrl,
                network: {
                    defaultHeaders: { "X-Default": "1", "X-Override": "old" },
                },
            });

            try {
                await pool.request("/headers", {
                    headers: { "X-Override": "new", "X-Request": "2" },
                });

                const requests = mockServer.getRequests();
                const headers = requests[0].headers;
                expect(headers["x-default"]).toBe("1");
                expect(headers["x-override"]).toBe("new");
                expect(headers["x-request"]).toBe("2");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should not overwrite existing Content-Type when sending objects", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start();
            const pool = new CallPool({ baseUrl });

            try {
                await pool.request("/custom-type", {
                    method: "POST",
                    body: { a: 1 },
                    headers: { "Content-Type": "application/vnd.api+json" },
                });

                const requests = mockServer.getRequests();
                expect(requests[0].headers["content-type"]).toBe("application/vnd.api+json");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });
    });

    describe("Response Parsing", () => {
        it("should return text if content-type is not JSON", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                body: "hello world",
                headers: { "Content-Type": "text/plain" },
            });
            const pool = new CallPool({ baseUrl });

            try {
                const result = await pool.request("/text");
                expect(result).toBe("hello world");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });
    });
});
