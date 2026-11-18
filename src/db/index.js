import "dotenv/config";
import { createFailoverPool, parseDbHosts } from "./failoverPool.js";

// Host list (in priority order) = DB_HOSTS (or DB_HOST:DB_PORT) then
// DB_FALLBACK_HOST. All hosts share the same user/password/database — they
// are expected to be the same data (primary + synced replicas).
const pool = createFailoverPool({
  hosts: parseDbHosts({ ...process.env, DB_PORT: process.env.DB_PORT || "5431" }),
  poolOptions: {
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || "tally_dashboard",
    // The server has a hard max_connections (~100) shared by every backend,
    // connector and tool; 20 per process exhausted it. Override with DB_POOL_MAX.
    max: Number(process.env.DB_POOL_MAX) || 10,
    min: 0,                           // don't hold slots while idle
    idleTimeoutMillis: 10000,
    keepAlive: true,                  // lets the OS notice dead peers (no zombie connections)
    keepAliveInitialDelayMillis: 10000,
    application_name: "tally-be",
    connectionTimeoutMillis: 15000,   // was 2000 — too tight under load
    allowExitOnIdle: false,
  },
  probeTimeoutMs: Number(process.env.DB_PROBE_TIMEOUT_MS) || 3000,
  failbackIntervalMs: Number(process.env.DB_FAILBACK_INTERVAL_MS) || 30000,
});

// Retries with backoff instead of exiting on the first attempt — a DB that
// just restarted/failed over can report "the database system is in
// recovery mode" or ECONNRESET for a short window. Each attempt now probes
// every configured host (including DB_FALLBACK_HOST); the process only exits
// when ALL of them stay unreachable for the whole retry budget.
pool.verifyAtStartup({ retries: 5, delayMs: 3000 });

export default pool;
