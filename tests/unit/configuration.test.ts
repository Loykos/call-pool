import { describe, it, expect } from "vitest";
import { CallPool } from "../../src/index";
import { MockServer } from "../setup/mock-server";

describe.concurrent("Configuration Enforcement", () => {
    describe("Network Configuration", () => {
        it("should apply default headers from configuration to all requests", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start();

            const pool = new CallPool({
                baseUrl,
                network: {
                    defaultHeaders: {
                        "X-App-Name": "CallPool-Test",
                        "X-Env": "Test",
                    },
                },
            });

            try {
                await pool.request("/config-test");
                const requests = mockServer.getRequests();

                // Verifichiamo che gli headers configurati siano stati inviati
                expect(requests[0].headers["x-app-name"]).toBe("CallPool-Test");
                expect(requests[0].headers["x-env"]).toBe("Test");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should respect the custom timeout configuration", async () => {
            const mockServer = new MockServer();
            // Server che risponde dopo 2 secondi
            const baseUrl = await mockServer.start({ latency: 2000 });

            const pool = new CallPool({
                baseUrl,
                network: { timeout: 800 }, // Timeout configurato a meno della latenza
                retry: { maxAttempts: 0 }, // Nessun retry per isolare il timeout
            });

            try {
                const start = Date.now();
                await expect(pool.request("/timeout-test")).rejects.toThrow();
                const duration = Date.now() - start;

                // La richiesta deve essere stata interrotta dal timeout configurato
                expect(duration).toBeLessThan(1500);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });
    });

    describe("URL Normalization", () => {
        it("should handle baseUrl with or without trailing slash seamlessly", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start();

            // Configuriamo due pool con baseUrl leggermente diverse
            const poolA = new CallPool({ baseUrl: `${baseUrl}/` }); // Slash finale
            const poolB = new CallPool({ baseUrl: baseUrl }); // Senza slash

            try {
                await poolA.request("/test");
                await poolB.request("/test");

                const requests = mockServer.getRequests();
                expect(requests[0].path).toBe("/test");
                expect(requests[1].path).toBe("/test");
            } finally {
                await Promise.all([poolA.close(), poolB.close(), mockServer.stop()]);
            }
        });
    });
});
