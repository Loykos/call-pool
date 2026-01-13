import { CallPool } from "./src/index";

async function demo() {
    console.log("🚀 CallPool Demo\n");

    // Crea un pool con rate limiting
    const pool = new CallPool({
        baseUrl: "https://jsonplaceholder.typicode.com",
        concurrency: {
            limit: 5,
        },
        rateLimit: {
            minTime: 100, // 100ms tra le richieste
        },
        retry: {
            maxAttempts: 3,
            delay: 1000,
        },
        network: {
            timeout: 10000,
        },
    });

    try {
        // Test 1: GET request semplice
        console.log("📥 Test 1: GET request");
        const users = await pool.request<any[]>("/users");
        console.log(`✅ Ricevuti ${users.length} utenti`);
        console.log(`   Primo utente: ${users[0]?.name}\n`);

        // Test 2: GET request con ID
        console.log("📥 Test 2: GET request con ID");
        const user = await pool.request<any>("/users/1");
        console.log(`✅ Utente: ${user.name} (${user.email})\n`);

        // Test 3: POST request
        console.log("📤 Test 3: POST request");
        const newPost = await pool.request<any>("/posts", {
            method: "POST",
            body: {
                title: "Test Post",
                body: "Questo è un post di test",
                userId: 1,
            },
        });
        console.log(`✅ Post creato con ID: ${newPost.id}\n`);

        // Test 4: Multiple requests in parallelo
        console.log("📥 Test 4: Multiple requests in parallelo (con rate limiting)");
        const start = Date.now();
        const promises = Array.from({ length: 10 }, (_, i) => pool.request<any>(`/posts/${i + 1}`));
        const results = await Promise.all(promises);
        const duration = Date.now() - start;
        console.log(`✅ Completate ${results.length} richieste in ${duration}ms`);
        console.log(`   Media: ${(duration / results.length).toFixed(0)}ms per richiesta\n`);

        // Test 5: Priorità
        console.log("📥 Test 5: Richiesta con priorità alta");
        const urgent = await pool.request<any>("/posts/1", {
            priority: 9,
        });
        console.log(`✅ Richiesta urgente completata: ${urgent.title}\n`);

        console.log("✅ Tutti i test completati con successo!");
    } catch (error) {
        console.error("❌ Errore:", error);
    } finally {
        await pool.close();
        console.log("\n🔒 Pool chiuso");
    }
}

demo().catch(console.error);
