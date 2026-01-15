import { createServer, Server } from "http";
import { AddressInfo } from "net";

export interface MockServerOptions {
    latency?: number | (() => number);
    statusCode?: number | (() => number);
    headers?: Record<string, string> | (() => Record<string, string>);
    body?: string | object;
    onRequest?: (req: any) => void;
}

export class MockServer {
    private server: Server | null = null;
    private port: number = 0;
    private requestCount: number = 0;
    private requests: Array<{ method: string; path: string; headers: Record<string, string>; body?: string }> = [];

    async start(options: MockServerOptions = {}): Promise<string> {
        return new Promise((resolve, reject) => {
            this.server = createServer(async (req, res) => {
                this.requestCount++;
                const bodyChunks: Buffer[] = [];

                req.on("data", chunk => {
                    bodyChunks.push(chunk);
                });

                req.on("end", async () => {
                    const body = bodyChunks.length > 0 ? Buffer.concat(bodyChunks).toString() : undefined;

                    this.requests.push({
                        method: req.method || "GET",
                        path: req.url || "/",
                        headers: req.headers as Record<string, string>,
                        body,
                    });

                    if (options.onRequest) {
                        options.onRequest(req);
                    }

                    // Simula latenza
                    if (options.latency) {
                        const latency = typeof options.latency === "function" ? options.latency() : options.latency;
                        await new Promise(r => setTimeout(r, latency));
                    }

                    // Headers di risposta
                    const headers = typeof options.headers === "function" ? options.headers() : options.headers || { "Content-Type": "application/json" };
                    Object.entries(headers).forEach(([key, value]) => {
                        res.setHeader(key, value);
                    });

                    // Status code
                    const statusCode = typeof options.statusCode === "function" ? options.statusCode() : options.statusCode || 200;
                    res.statusCode = statusCode;

                    // Body di risposta
                    const responseBody =
                        options.body !== undefined
                            ? typeof options.body === "string"
                                ? options.body
                                : JSON.stringify(options.body)
                            : JSON.stringify({ success: true });
                    res.end(responseBody);
                });
            });

            this.server.listen(0, () => {
                const address = this.server?.address() as AddressInfo;
                this.port = address.port;
                resolve(`http://localhost:${this.port}`);
            });

            this.server.on("error", reject);
        });
    }

    async stop(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.server) {
                resolve();
                return;
            }

            this.server.close(err => {
                if (err) {
                    reject(err);
                } else {
                    this.server = null;
                    resolve();
                }
            });
        });
    }

    getRequestCount(): number {
        return this.requestCount;
    }

    getRequests(): Array<{ method: string; path: string; headers: Record<string, string>; body?: string }> {
        return [...this.requests];
    }

    reset(): void {
        this.requestCount = 0;
        this.requests = [];
    }

    getUrl(): string {
        return `http://localhost:${this.port}`;
    }
}
