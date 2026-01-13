# CallPool

HTTP request pool con rate limiting, retry automatico e adaptive throttling per Node.js.

## Caratteristiche

-   **Pool di connessioni HTTP**: Utilizza `undici` per gestire efficientemente le connessioni TCP
-   **Rate Limiting**: Configurabile con quota e finestre temporali
-   **Adaptive Throttling**: Rallenta automaticamente quando rileva congestione
-   **Retry automatico**: Retry con backoff esponenziale per errori di rete e server
-   **Priorità delle richieste**: Sistema di code con priorità (0-9)
-   **TypeScript**: Completamente tipizzato

## Installazione

```bash
pnpm install call-pool
```

## Esempi

### Esempio Minimal

Configurazione minima con solo l'URL base. Usa i valori di default per tutte le opzioni.

```typescript
import { CallPool } from "call-pool";

const pool = new CallPool({
    baseUrl: "https://api.example.com",
});

const data = await pool.request("/endpoint");
await pool.close();
```

### Esempio con Throttling e Quota

Per servizi con limiti di rate (es. API esterne con quota contrattuale). Il pool distribuisce automaticamente le richieste nella finestra temporale.

```typescript
import { CallPool } from "call-pool";

const pool = new CallPool({
    baseUrl: "https://api.external-service.com",
    concurrency: {
        limit: 5, // Massimo 5 richieste simultanee
    },
    rateLimit: {
        minTime: "auto", // Calcola automaticamente il delay dalla quota
        quota: {
            max: 100, // 100 richieste
            window: 60000, // in 60 secondi (1 minuto)
        },
        congestionThreshold: 2.5, // Rallenta se latenza > 2.5x la media
    },
    retry: {
        maxAttempts: 5, // Più tentativi per servizi esterni
        delay: 2000, // 2 secondi di attesa iniziale
        factor: 2, // Backoff esponenziale: 2s, 4s, 8s, 16s, 32s
    },
});

const result = await pool.request("/api/data");
await pool.close();
```

### Esempio Full Configuration

Configurazione completa con tutte le opzioni settate esplicitamente.

```typescript
import { CallPool } from "call-pool";

const pool = new CallPool({
    baseUrl: "https://api.example.com",
    concurrency: {
        limit: 20, // 20 richieste simultanee
    },
    rateLimit: {
        minTime: 50, // 50ms tra ogni richiesta (oppure "auto" se usi quota)
        quota: {
            max: 1000, // 1000 richieste
            window: 3600000, // in 1 ora
        },
        congestionThreshold: 2.0, // Soglia per adaptive throttling
    },
    retry: {
        maxAttempts: 3, // Massimo 3 tentativi
        delay: 1000, // 1 secondo di delay iniziale
        factor: 2, // Backoff: 1s, 2s, 4s
    },
    network: {
        timeout: 30000, // 30 secondi di timeout
        defaultHeaders: {
            Authorization: "Bearer your-token-here",
            "User-Agent": "MyApp/1.0",
            "Content-Type": "application/json",
        },
    },
});

// Esempi di utilizzo
const users = await pool.request<User[]>("/users");

const newUser = await pool.request<User>("/users", {
    method: "POST",
    body: { name: "John", email: "john@example.com" },
    priority: 9, // Priorità alta
});

const urgent = await pool.request("/urgent", {
    method: "GET",
    priority: 9,
    headers: {
        "X-Custom-Header": "value",
    },
});

await pool.close();
```

## Utilizzo Base

```typescript
import { CallPool } from "call-pool";

const pool = new CallPool({
    baseUrl: "https://api.example.com",
    concurrency: {
        limit: 10,
    },
    rateLimit: {
        minTime: "auto",
        quota: {
            max: 100,
            window: 60000, // 100 richieste al minuto
        },
    },
    retry: {
        maxAttempts: 3,
        delay: 1000,
        factor: 2,
    },
    network: {
        timeout: 30000,
        defaultHeaders: {
            Authorization: "Bearer token",
        },
    },
});

// GET request
const users = await pool.request<User[]>("/users");

// POST request
const newUser = await pool.request<User>("/users", {
    method: "POST",
    body: { name: "John", email: "john@example.com" },
});

// Richiesta con priorità alta
const urgent = await pool.request("/urgent", {
    priority: 9,
});

// Chiudi il pool quando hai finito
await pool.close();
```

## Configurazione

### CallPoolOptions

-   `baseUrl` (obbligatorio): URL base per tutte le richieste
-   `concurrency.limit`: Numero massimo di richieste simultanee (default: 10)
-   `rateLimit.minTime`: Tempo minimo tra richieste in ms, oppure `"auto"` per calcolo automatico
-   `rateLimit.quota`: Quota contrattuale (es. 100 richieste al minuto)
-   `rateLimit.congestionThreshold`: Soglia per adaptive throttling (default: 2.0)
-   `retry.maxAttempts`: Numero massimo di tentativi (default: 3)
-   `retry.delay`: Ritardo base per retry in ms (default: 1000)
-   `retry.factor`: Fattore di backoff esponenziale (default: 2)
-   `network.timeout`: Timeout per singola richiesta in ms (default: 30000)
-   `network.defaultHeaders`: Headers da includere in ogni richiesta

### RequestOptions

-   `method`: Metodo HTTP (GET, POST, PUT, DELETE, ecc.)
-   `priority`: Priorità nella coda (0-9, default: 5, 9 è la più alta)
-   `body`: Body della richiesta (può essere oggetto JS, verrà serializzato automaticamente)
-   `headers`: Headers aggiuntivi per la singola richiesta

## Adaptive Throttling

Il pool monitora automaticamente la latenza delle richieste e rallenta quando rileva congestione:

-   Calcola una media mobile esponenziale (EMA) della latenza
-   Se una richiesta è più lenta della media moltiplicata per `congestionThreshold`, aumenta il delay
-   Quando le richieste tornano veloci, ripristina il delay originale

## Gestione Errori

-   **429 (Rate Limit)**: Rileva automaticamente `Retry-After` header e attende
-   **5xx (Server Error)**: Retry automatico
-   **4xx (Client Error)**: Non viene fatto retry (AbortError)
-   **Network Error**: Retry automatico

## Dipendenze

-   `undici`: Pool di connessioni HTTP ad alte prestazioni
-   `bottleneck`: Rate limiting e gestione code
-   `p-retry`: Retry con backoff esponenziale

## Licenza

MIT
