import { Pool, Dispatcher } from "undici";
import Bottleneck from "bottleneck";
import pRetry, { AbortError, Options as PRetryOptions } from "p-retry";

// ==========================================
// CONFIGURATION TYPES
// ==========================================

export interface CallPoolOptions {
    /** L'URL base per tutte le richieste (es. "https://api.example.com") */
    baseUrl: string;

    /** * Configurazione del parallelismo (Il "Tubo").
     * Gestisce quante richieste vengono aperte simultaneamente.
     */
    concurrency?: {
        /** * Numero massimo di richieste simultanee.
         * Configura sia i socket TCP di Undici che la coda logica.
         * Default: 10
         */
        limit?: number;
    };

    /** * Configurazione della frequenza e limiti (Il "Freno").
     * Gestisce la velocità e le quote.
     */
    rateLimit?: {
        /**
         * Tempo minimo di attesa tra due richieste in ms.
         * - Se `number`: Attesa fissa (es. 50ms).
         * - Se `"auto"`: Calcola automaticamente l'attesa per distribuire la quota uniformemente.
         * (Richiede che `quota` sia definito).
         * Default: 0
         */
        minTime?: number | "auto";

        /** Quota contrattuale (es. 100 richieste al minuto) */
        quota?: {
            max: number; // es. 100
            window: number; // es. 60000 (ms)
        };

        /** * Abilita il rallentamento automatico basato sulla latenza (Adaptive Throttling).
         * Se abilitato, il pool monitora la latenza e rallenta quando rileva congestione.
         * Default: false
         */
        enableAdaptiveThrottling?: boolean;

        /** * Soglia di latenza per il rallentamento automatico (Adaptive Throttling).
         * Se una richiesta è X volte più lenta della media, il pool rallenta temporaneamente.
         * Ha effetto solo se `enableAdaptiveThrottling` è true.
         * Default: 2.0
         */
        congestionThreshold?: number;

        /** * Fattore di riduzione per il soft landing (Adaptive Throttling).
         * Quando la congestione si risolve, il pool riduce gradualmente il delay moltiplicandolo per questo fattore.
         * Valore tra 0 e 1 (es. 0.8 = riduzione del 20%).
         * Ha effetto solo se `enableAdaptiveThrottling` è true.
         * Default: 0.8
         */
        recoveryFactor?: number;

        /** * Valore massimo configurabile per minTime durante l'Adaptive Throttling.
         * Quando il pool rileva congestione, può aumentare minTime fino a questo valore.
         * Ha effetto solo se `enableAdaptiveThrottling` è true.
         * Default: 5000
         */
        maxMinTime?: number;
    };

    /** Configurazione Resilienza (Retry) */
    retry?: {
        /** Numero massimo di tentativi. Default: 3 */
        maxAttempts?: number;
        /** Ritardo base in ms prima del primo retry. Default: 1000 */
        delay?: number;
        /** Fattore di backoff esponenziale (1s -> 2s -> 4s). Default: 2 */
        factor?: number;
    };

    /** Opzioni Generiche di Rete */
    network?: {
        /** Timeout del socket per singola richiesta in ms. Default: 30000 */
        timeout?: number;
        /** Headers da includere in ogni richiesta */
        defaultHeaders?: Record<string, string>;
    };
}

/** Opzioni per la singola richiesta */
export interface RequestOptions extends Omit<Dispatcher.RequestOptions, "origin" | "path" | "method" | "body"> {
    method?: Dispatcher.HttpMethod;
    /** Priorità nella coda (0-9, default 5). 9 è la più alta. */
    priority?: number;
    /** Override manuale del body (accetta anche oggetti JS diretti) */
    body?: string | Buffer | Uint8Array | Record<string, any> | null;
}

// ==========================================
// MAIN CLASS
// ==========================================

export class CallPool {
    private client: Pool;
    private limiter: Bottleneck;

    // Runtime Config
    private retryOptions: PRetryOptions;
    private requestTimeout: number;
    private defaultHeaders: Record<string, string>;
    private enableAdaptiveThrottling: boolean;
    private congestionThreshold: number;
    private recoveryFactor: number;
    private maxMinTime: number;

    // Adaptive State
    private avgLatency: number = 0;
    private baseMinTime: number;
    private currentMinTime: number;

    constructor(options: CallPoolOptions) {
        // Defaults
        const concurrencyLimit = options.concurrency?.limit ?? 1;
        this.enableAdaptiveThrottling = options.rateLimit?.enableAdaptiveThrottling ?? false;
        this.congestionThreshold = options.rateLimit?.congestionThreshold ?? 2.0;
        this.recoveryFactor = options.rateLimit?.recoveryFactor ?? 0.8;
        this.maxMinTime = options.rateLimit?.maxMinTime ?? 5000;
        this.requestTimeout = options.network?.timeout ?? 30_000;
        this.defaultHeaders = options.network?.defaultHeaders ?? {};

        this.retryOptions = {
            retries: options.retry?.maxAttempts ?? 3,
            minTimeout: options.retry?.delay ?? 1000,
            factor: options.retry?.factor ?? 2,
        };

        // --- 1. CALCOLO minTime ("AUTO" vs MANUAL) ---
        const rateOpts = options.rateLimit;

        if (rateOpts?.minTime === "auto") {
            if (!rateOpts.quota) {
                throw new Error("[CallPool] Configuration Error: Cannot set minTime to 'auto' without defining a 'quota'.");
            }
            // Distribuisce le chiamate equamente nella finestra temporale
            this.baseMinTime = Math.ceil(rateOpts.quota.window / rateOpts.quota.max);
        } else {
            this.baseMinTime = rateOpts?.minTime ?? 0;
        }

        this.currentMinTime = this.baseMinTime;

        // --- 2. SETUP UNDICI (Network Layer) ---
        this.client = new Pool(options.baseUrl, {
            connections: concurrencyLimit,
            pipelining: 1,
            keepAliveTimeout: 10_000,
        });

        // --- 3. SETUP BOTTLENECK (Control Layer) ---
        this.limiter = new Bottleneck({
            // Concurrency
            maxConcurrent: concurrencyLimit,

            // Rate Limiting (Calculated or Manual)
            minTime: this.baseMinTime,

            // Quota / Reservoir (Se presente)
            reservoir: rateOpts?.quota?.max ?? null,
            reservoirRefreshAmount: rateOpts?.quota?.max ?? null,
            reservoirRefreshInterval: rateOpts?.quota?.window ?? null,

            // Queue Strategy
            strategy: Bottleneck.strategy.BLOCK, // Blocca nuove aggiunte se la coda è piena
            highWater: 10_000,
        });

        this.setupMonitoring();
    }

    private setupMonitoring() {
        this.limiter.on("error", err => {
            // Errori interni al limiter (es. Redis disconnesso se usato in cluster)
            if (process.env.NODE_ENV !== "production") console.error("[CallPool] Limiter Error:", err);
        });
    }

    /**
     * Esegue una richiesta HTTP gestita dal pool.
     * @param path Path relativo (es. "/users")
     * @param options Opzioni della richiesta
     */
    public async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
        const { priority = 5, ...reqOpts } = options;

        return this.limiter.schedule({ priority }, () => this.executeWithRetry<T>(path, reqOpts));
    }

    /** Logica Core: Retry, Request, Parsing, Adaptive Logic */
    private async executeWithRetry<T>(path: string, reqOpts: Omit<RequestOptions, "priority">): Promise<T> {
        return pRetry(async () => {
            const start = Date.now();
            let response: Dispatcher.ResponseData;

            // 1. Prepare Request
            try {
                let body = reqOpts.body;
                const headers = { ...this.defaultHeaders, ...reqOpts.headers } as Record<string, string>;

                // Auto-JSON stringify
                if (body && typeof body === "object" && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
                    body = JSON.stringify(body);
                    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
                }

                response = await this.client.request({
                    path,
                    method: reqOpts.method || "GET",
                    headers,
                    body: body as string | Buffer | Uint8Array | null,
                    headersTimeout: this.requestTimeout,
                });
            } catch (err) {
                // Network error puro -> Retry
                throw err;
            }

            // 2. Status Code Handling
            if (response.statusCode === 429) {
                // Non aggiorniamo throttling per 429: è un rate limit esplicito, non un problema di latenza
                const retryAfter = Number(response.headers["retry-after"]) || 5;
                await this.forceWait(retryAfter * 1000);
                throw new Error(`Rate Limit Hit (429)`);
            }

            // 3. Adaptive Logic (Aggiornamento latenza e throttling)
            const duration = Date.now() - start;
            if (this.enableAdaptiveThrottling && duration > 100) {
                this.updateThrottleLogic(duration);
            }

            if (response.statusCode >= 500) {
                throw new Error(`Server Error: ${response.statusCode}`);
            }

            if (response.statusCode >= 400) {
                const errBody = await response.body.text();
                throw new AbortError(`Client Error ${response.statusCode}: ${errBody}`);
            }

            // 4. Parsing
            const contentType = response.headers["content-type"];
            if (contentType && contentType.includes("application/json")) {
                return (await response.body.json()) as T;
            }
            return (await response.body.text()) as unknown as T;
        }, this.retryOptions);
    }

    // ==========================================
    // ADAPTIVE THROTTLING LOGIC
    // ==========================================

    private updateThrottleLogic(duration: number) {
        // Exponential Moving Average (EMA)
        if (this.avgLatency === 0) {
            this.avgLatency = duration;
        } else {
            // Peso del 10% alla nuova richiesta
            this.avgLatency = 0.1 * duration + 0.9 * this.avgLatency;
        }

        // Se la durata attuale è molto sopra la media -> Congestione -> Rallenta
        if (duration > this.avgLatency * this.congestionThreshold) {
            this.increaseDelay();
        } else if (this.currentMinTime > this.baseMinTime) {
            // Soft landing: se non c'è congestione E siamo ancora rallentati, recupera gradualmente
            // Non serve controllare duration < avgLatency perché se non c'è congestione, possiamo recuperare
            this.decreaseDelay();
        }
    }

    private increaseDelay() {
        // Moltiplichiamo il ritardo ATTUALE, non quello base, per scalare se la congestione persiste
        // Cap massimo configurabile per non "uccidere" il pool
        const nextDelay = Math.max(this.currentMinTime * 2, 200);
        this.currentMinTime = Math.min(nextDelay, this.maxMinTime);

        this.limiter.updateSettings({ minTime: this.currentMinTime });
    }

    private decreaseDelay() {
        // Riduciamo gradualmente usando il recoveryFactor invece di resettare subito
        const nextDelay = this.currentMinTime * this.recoveryFactor;

        // Non scendiamo mai sotto il baseMinTime definito dall'utente
        this.currentMinTime = Math.max(nextDelay, this.baseMinTime);

        this.limiter.updateSettings({ minTime: this.currentMinTime });
    }

    private async forceWait(ms: number) {
        // Aspetta il tempo indicato da Retry-After header
        // Bottleneck gestisce rate limiting, p-retry gestisce il retry
        await new Promise(r => setTimeout(r, ms));
    }

    public getCurrentMinTime() {
        return this.currentMinTime;
    }

    /** Chiude pool e limiter per liberare le risorse */
    public async close() {
        await this.limiter.stop();
        await this.client.close();
    }
}
