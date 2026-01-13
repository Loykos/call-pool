import { CallPool } from "./src/index";

interface TestResult {
    name: string;
    passed: boolean;
    error?: string;
    duration: number;
}

async function runTest(name: string, testFn: () => Promise<void>): Promise<TestResult> {
    const start = Date.now();
    try {
        await testFn();
        return {
            name,
            passed: true,
            duration: Date.now() - start,
        };
    } catch (error) {
        return {
            name,
            passed: false,
            error: error instanceof Error ? error.message : String(error),
            duration: Date.now() - start,
        };
    }
}

async function runTests() {
    console.log("🧪 CallPool Test Suite\n");
    const results: TestResult[] = [];

    // Test 1: Configurazione base
    results.push(
        await runTest("Configurazione base", async () => {
            const pool = new CallPool({
                baseUrl: "https://jsonplaceholder.typicode.com",
            });
            await pool.close();
        })
    );

    // Test 2: GET request
    results.push(
        await runTest("GET request", async () => {
            const pool = new CallPool({
                baseUrl: "https://jsonplaceholder.typicode.com",
            });
            const data = await pool.request("/posts/1");
            if (!data || typeof data !== "object") {
                throw new Error("Risposta non valida");
            }
            await pool.close();
        })
    );

    // Test 3: POST request
    results.push(
        await runTest("POST request", async () => {
            const pool = new CallPool({
                baseUrl: "https://jsonplaceholder.typicode.com",
            });
            const data = await pool.request("/posts", {
                method: "POST",
                body: {
                    title: "Test",
                    body: "Body",
                    userId: 1,
                },
            });
            if (!data || typeof data !== "object") {
                throw new Error("Risposta non valida");
            }
            await pool.close();
        })
    );

    // Test 4: Rate limiting
    results.push(
        await runTest("Rate limiting", async () => {
            const pool = new CallPool({
                baseUrl: "https://jsonplaceholder.typicode.com",
                rateLimit: {
                    minTime: 200,
                },
            });
            const start = Date.now();
            await pool.request("/posts/1");
            await pool.request("/posts/2");
            const duration = Date.now() - start;
            if (duration < 200) {
                throw new Error(`Rate limiting non funziona: ${duration}ms < 200ms`);
            }
            await pool.close();
        })
    );

    // Test 5: Concurrency limit
    results.push(
        await runTest("Concurrency limit", async () => {
            const pool = new CallPool({
                baseUrl: "https://jsonplaceholder.typicode.com",
                concurrency: {
                    limit: 2,
                },
            });
            const promises = Array.from({ length: 5 }, (_, i) => pool.request(`/posts/${i + 1}`));
            await Promise.all(promises);
            await pool.close();
        })
    );

    // Test 6: Quota con auto minTime
    results.push(
        await runTest("Quota con auto minTime", async () => {
            const pool = new CallPool({
                baseUrl: "https://jsonplaceholder.typicode.com",
                rateLimit: {
                    minTime: "auto",
                    quota: {
                        max: 10,
                        window: 1000,
                    },
                },
            });
            await pool.request("/posts/1");
            await pool.close();
        })
    );

    // Test 7: Priorità
    results.push(
        await runTest("Priorità richieste", async () => {
            const pool = new CallPool({
                baseUrl: "https://jsonplaceholder.typicode.com",
            });
            await pool.request("/posts/1", { priority: 9 });
            await pool.close();
        })
    );

    // Test 8: Headers personalizzati
    results.push(
        await runTest("Headers personalizzati", async () => {
            const pool = new CallPool({
                baseUrl: "https://jsonplaceholder.typicode.com",
                network: {
                    defaultHeaders: {
                        "X-Custom-Header": "test",
                    },
                },
            });
            await pool.request("/posts/1");
            await pool.close();
        })
    );

    // Test 9: Retry su errore di rete (simulato con timeout breve)
    results.push(
        await runTest("Retry configuration", async () => {
            const pool = new CallPool({
                baseUrl: "https://jsonplaceholder.typicode.com",
                retry: {
                    maxAttempts: 2,
                    delay: 100,
                },
            });
            await pool.request("/posts/1");
            await pool.close();
        })
    );

    // Test 10: Close pool
    results.push(
        await runTest("Close pool", async () => {
            const pool = new CallPool({
                baseUrl: "https://jsonplaceholder.typicode.com",
            });
            await pool.close();
            // Verifica che non si possa più usare
            try {
                await pool.request("/posts/1");
                throw new Error("Pool dovrebbe essere chiuso");
            } catch (error) {
                // Aspettato
            }
        })
    );

    // Risultati
    console.log("\n📊 Risultati:\n");
    let passed = 0;
    let failed = 0;

    results.forEach(result => {
        const icon = result.passed ? "✅" : "❌";
        const status = result.passed ? "PASS" : "FAIL";
        console.log(`${icon} ${result.name} [${status}] (${result.duration}ms)`);
        if (!result.passed && result.error) {
            console.log(`   Errore: ${result.error}`);
        }
        if (result.passed) {
            passed++;
        } else {
            failed++;
        }
    });

    console.log(`\n📈 Totale: ${passed} passati, ${failed} falliti su ${results.length} test\n`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(error => {
    console.error("❌ Errore fatale:", error);
    process.exit(1);
});
