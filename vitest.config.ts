import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["tests/**/*.test.ts"],
        exclude: ["node_modules/", "dist/", "**/*.js"],
        coverage: {
            provider: "v8",
            reporter: ["text", "json", "html"],
            exclude: ["node_modules/", "dist/", "tests/", "*.config.ts", "demo.ts", "test.ts"],
        },
        testTimeout: 30000,
        hookTimeout: 30000,
    },
    esbuild: {
        sourcemap: "inline", // 'inline' è spesso più stabile per il debug locale
        target: "es2020",
    },
});
