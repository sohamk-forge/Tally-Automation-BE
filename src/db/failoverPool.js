import pkg from "pg";

const { Pool, Client } = pkg;

/*
 * Priority-ordered Postgres failover.
 *
 * Hosts come from env, in order:
 *   DB_HOSTS          comma-separated host[:port] list (defaults to DB_HOST:DB_PORT)
 *   DB_FALLBACK_HOST  final host[:port], tried only after every DB_HOSTS entry
 *
 * One pg.Pool per host, created lazily; only the active one takes traffic.
 * The exported object keeps pg.Pool's promise API (query / connect), so the
 * ~100 `import pool from "../db/index.js"` callers don't change.
 *
 * Failover only happens while ACQUIRING a connection — a query that already
 * reached the server is never re-run, so an INSERT can't execute twice.
 */

const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "EAI_AGAIN",
  "EPIPE",
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now (starting up / recovery)
]);

const CONNECTION_ERROR_MESSAGE =
  /timeout exceeded when trying to connect|Connection terminated|Cannot use a pool after calling end|the database system is (starting up|shutting down|in recovery mode)/i;

export function isConnectionError(err) {
  if (!err) return false;
  if (CONNECTION_ERROR_CODES.has(err.code)) return true;
  // SQLSTATE class 08 = connection exception
  if (typeof err.code === "string" && /^08/.test(err.code)) return true;
  return CONNECTION_ERROR_MESSAGE.test(String(err.message || ""));
}

function parseHostEntry(entry, defaultPort) {
  const value = entry.trim();
  if (!value) return null;
  // [ipv6]:port | host:port | host
  const v6 = value.match(/^\[(.+)\](?::(\d+))?$/);
  if (v6) return { host: v6[1], port: Number(v6[2]) || defaultPort };
  const parts = value.split(":");
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return { host: parts[0], port: Number(parts[1]) };
  }
  return { host: value, port: defaultPort };
}

export function parseDbHosts(env = process.env) {
  const defaultPort = Number(env.DB_PORT) || 5432;
  const listSource = env.DB_HOSTS && env.DB_HOSTS.trim()
    ? env.DB_HOSTS
    : env.DB_HOST || "127.0.0.1";

  const entries = listSource
    .split(",")
    .map((e) => parseHostEntry(e, defaultPort))
    .filter(Boolean);

  const fallback = env.DB_FALLBACK_HOST
    ? parseHostEntry(env.DB_FALLBACK_HOST, defaultPort)
    : null;

  const seen = new Set();
  const hosts = [];
  const push = (h, label) => {
    const key = `${h.host}:${h.port}`;
    if (seen.has(key)) return;
    seen.add(key);
    hosts.push({ ...h, label });
  };

  entries.forEach((h, i) => push(h, i === 0 ? "primary" : `env#${i + 1}`));
  if (fallback) push(fallback, "fallback");

  return hosts;
}

export function createFailoverPool({
  hosts,
  poolOptions,
  probeTimeoutMs = 3000,
  failbackIntervalMs = 30000,
  logger = console,
}) {
  if (!hosts.length) throw new Error("[db-failover] no DB hosts configured");

  const state = hosts.map(() => ({
    healthy: null,
    readOnly: null,
    lastCheckedAt: null,
    lastError: null,
  }));
  const pools = new Map(); // index -> pg.Pool
  let activeIndex = 0;
  let failoverInFlight = null;
  let failbackTimer = null;

  const describe = (i) => `${hosts[i].label} (${hosts[i].host}:${hosts[i].port})`;

  function getPool(i) {
    let p = pools.get(i);
    if (!p) {
      p = new Pool({ ...poolOptions, host: hosts[i].host, port: hosts[i].port });
      // Without this, an idle client dying (DB restart, network drop) emits an
      // unhandled 'error' on the pool.
      p.on("error", (err) => {
        logger.error(`[db-failover] idle client error on ${describe(i)}:`, err.message);
        if (i === activeIndex && isConnectionError(err)) {
          failover().catch(() => {});
        }
      });
      pools.set(i, p);
    }
    return p;
  }

  async function probe(i) {
    const client = new Client({
      ...poolOptions,
      host: hosts[i].host,
      port: hosts[i].port,
      connectionTimeoutMillis: probeTimeoutMs,
      query_timeout: probeTimeoutMs,
    });
    client.on("error", () => {});
    try {
      await client.connect();
      const { rows } = await client.query("SELECT pg_is_in_recovery() AS ro");
      Object.assign(state[i], {
        healthy: true,
        readOnly: rows[0].ro === true,
        lastCheckedAt: new Date().toISOString(),
        lastError: null,
      });
    } catch (err) {
      Object.assign(state[i], {
        healthy: false,
        lastCheckedAt: new Date().toISOString(),
        lastError: err.code || err.message,
      });
    } finally {
      client.end().catch(() => {});
    }
    return state[i];
  }

  // First healthy writable host in priority order; else first healthy
  // read-only one; else -1.
  function pickBest() {
    const writable = state.findIndex((s) => s.healthy && !s.readOnly);
    if (writable !== -1) return writable;
    return state.findIndex((s) => s.healthy);
  }

  function switchTo(next) {
    if (next === activeIndex) return;
    const prev = activeIndex;
    activeIndex = next;
    logger.warn(`[db-failover] ${describe(prev)} -> ${describe(next)}`);
    if (state[next].readOnly) {
      logger.error(
        `[db-failover] ${describe(next)} is a READ-ONLY replica (in recovery). ` +
          "Reads work; writes will fail until it is promoted or a writable host returns."
      );
    }
    const old = pools.get(prev);
    if (old) {
      pools.delete(prev);
      // end() waits for checked-out clients to be released before closing.
      old.end().catch(() => {});
    }
    scheduleFailback();
  }

  // Probe every host in parallel, move to the best one. Single-flight.
  function failover() {
    if (!failoverInFlight) {
      failoverInFlight = (async () => {
        await Promise.all(hosts.map((_, i) => probe(i)));
        const best = pickBest();
        if (best === -1) {
          const detail = hosts
            .map((_, i) => `${describe(i)}: ${state[i].lastError}`)
            .join("; ");
          throw new Error(`[db-failover] all DB hosts unreachable — ${detail}`);
        }
        switchTo(best);
        return best;
      })().finally(() => {
        failoverInFlight = null;
      });
    }
    return failoverInFlight;
  }

  // While not on the primary (or on a read-only host), keep checking whether
  // a better host is back.
  function scheduleFailback() {
    const needsWatch = activeIndex !== 0 || state[activeIndex].readOnly;
    if (needsWatch && !failbackTimer) {
      failbackTimer = setInterval(() => {
        failover()
          .then(() => {
            if (activeIndex === 0 && !state[0].readOnly) {
              clearInterval(failbackTimer);
              failbackTimer = null;
            }
          })
          .catch((err) => logger.error(err.message));
      }, failbackIntervalMs);
      failbackTimer.unref?.();
    }
  }

  async function connect() {
    try {
      return await getPool(activeIndex).connect();
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      logger.error(`[db-failover] connect failed on ${describe(activeIndex)}: ${err.message}`);
      await failover(); // throws if every host is down
      return getPool(activeIndex).connect();
    }
  }

  async function query(...args) {
    if (typeof args[args.length - 1] === "function") {
      throw new Error("[db-failover] callback-style pool.query is not supported; use the promise form");
    }
    const client = await connect();
    try {
      return await client.query(...args);
    } finally {
      client.release();
    }
  }

  async function verifyAtStartup({ retries = 5, delayMs = 3000 } = {}) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const idx = await failover();
        logger.log(
          `✅ PostgreSQL Connected Successfully — ${describe(idx)}` +
            (hosts.length > 1 ? ` [${hosts.length} hosts configured]` : "")
        );
        return;
      } catch (err) {
        logger.error(`❌ DB Connection Error (attempt ${attempt}/${retries}):`, err.message);
        if (attempt === retries) {
          logger.error(`DB still unreachable on every host after ${retries} attempts — exiting.`);
          process.exit(1);
        }
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  function getStatus() {
    return {
      active: hosts[activeIndex].label,
      hosts: hosts.map((h, i) => ({
        label: h.label,
        healthy: state[i].healthy,
        readOnly: state[i].readOnly,
        lastCheckedAt: state[i].lastCheckedAt,
        lastError: state[i].lastError,
      })),
    };
  }

  async function end() {
    if (failbackTimer) clearInterval(failbackTimer);
    failbackTimer = null;
    await Promise.all([...pools.values()].map((p) => p.end().catch(() => {})));
    pools.clear();
  }

  return { query, connect, end, failover, verifyAtStartup, getStatus };
}
