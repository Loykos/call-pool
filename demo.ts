import { CallPool } from "./src/index";

async function demo() {
    console.log("🚀 CallPool Demo\n");

    // Create a pool with rate limiting
    const pool = new CallPool({
        baseUrl: "https://jsonplaceholder.typicode.com",
        concurrency: {
            limit: 5,
        },
        rateLimit: {
            minTime: 100, // 100ms between requests
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
        // Test 1: Simple GET request
        console.log("📥 Test 1: GET request");
        const users = await pool.request<any[]>("/users");
        console.log(`✅ Received ${users.length} users`);
        console.log(`   First user: ${users[0]?.name}\n`);

        // Test 2: GET request with ID
        console.log("📥 Test 2: GET request with ID");
        const user = await pool.request<any>("/users/1");
        console.log(`✅ User: ${user.name} (${user.email})\n`);

        // Test 3: POST request
        console.log("📤 Test 3: POST request");
        const newPost = await pool.request<any>("/posts", {
            method: "POST",
            body: {
                title: "Test Post",
                body: "This is a test post",
                userId: 1,
            },
        });
        console.log(`✅ Post created with ID: ${newPost.id}\n`);

        // Test 4: Multiple requests in parallel
        console.log("📥 Test 4: Multiple requests in parallel (with rate limiting)");
        const start = Date.now();
        const promises = Array.from({ length: 10 }, (_, i) => pool.request<any>(`/posts/${i + 1}`));
        const results = await Promise.all(promises);
        const duration = Date.now() - start;
        console.log(`✅ Completed ${results.length} requests in ${duration}ms`);
        console.log(`   Average: ${(duration / results.length).toFixed(0)}ms per request\n`);

        // Test 5: Priority
        console.log("📥 Test 5: High priority request");
        const urgent = await pool.request<any>("/posts/1", {
            priority: 9,
        });
        console.log(`✅ Urgent request completed: ${urgent.title}\n`);

        console.log("✅ All tests completed successfully!");
    } catch (error) {
        console.error("❌ Error:", error);
    } finally {
        await pool.close();
        console.log("\n🔒 Pool closed");
    }
}

demo().catch(console.error);
