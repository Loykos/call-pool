import { describe, it, expect } from "vitest";
import { CallPool } from "../../src/index";

const FAKE_PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const FAKE_KEY = "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n";

const build = (tls: any) => () => new CallPool({ baseUrl: "https://localhost", network: { tls } });

describe.concurrent("TLS Configuration Validation", () => {
    it("should accept a pool without any TLS option", () => {
        expect(() => new CallPool({ baseUrl: "https://localhost" })).not.toThrow();
    });

    it("should accept PEM content as string, Buffer and array", () => {
        expect(build({ ca: FAKE_PEM })).not.toThrow();
        expect(build({ ca: Buffer.from(FAKE_PEM) })).not.toThrow();
        expect(build({ ca: [FAKE_PEM, Buffer.from(FAKE_PEM)] })).not.toThrow();
    });

    it("should reject a file path passed instead of PEM content", () => {
        expect(build({ ca: "/etc/ssl/certs/custom-ca.pem" })).toThrow(/network\.tls\.ca.*PEM content, not a file path/);
    });

    it("should report the offending index when a CA array holds a path", () => {
        expect(build({ ca: [FAKE_PEM, "./ca.pem"] })).toThrow(/network\.tls\.ca\[1\]/);
    });

    it("should reject empty CA values", () => {
        expect(build({ ca: "" })).toThrow(/network\.tls\.ca/);
        expect(build({ ca: [] })).toThrow(/must not be an empty array/);
        expect(build({ ca: Buffer.alloc(0) })).toThrow(/network\.tls\.ca/);
    });

    it("should require cert and key together", () => {
        expect(build({ cert: FAKE_PEM })).toThrow(/must be provided together/);
        expect(build({ key: FAKE_KEY })).toThrow(/must be provided together/);
        expect(build({ cert: FAKE_PEM, key: FAKE_KEY })).not.toThrow();
    });

    it("should validate the remaining scalar options", () => {
        expect(build({ passphrase: 123 })).toThrow(/network\.tls\.passphrase/);
        expect(build({ servername: "" })).toThrow(/network\.tls\.servername/);
        expect(build({ rejectUnauthorized: "false" })).toThrow(/network\.tls\.rejectUnauthorized/);
    });

    it("should reject a non-object tls block", () => {
        expect(build("ca.pem")).toThrow(/'network\.tls' must be an object/);
        expect(build([FAKE_PEM])).toThrow(/'network\.tls' must be an object/);
    });

    it("should throw before opening any socket", () => {
        // Validation runs synchronously in the constructor: no close() needed
        expect(build({ ca: "not-a-pem" })).toThrow();
    });
});
