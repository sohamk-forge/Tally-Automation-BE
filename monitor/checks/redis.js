import IORedis from "ioredis";
import { config } from "../config.js";

let client, prev;
const getClient = () =>
  (client ||= new IORedis({
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 1, connectTimeout: 5000, enableOfflineQueue: false,
    retryStrategy: () => 3000,
  }).on("error", () => {}));

export const redisConn = getClient;

const parse = (s) => Object.fromEntries(s.split("\n").filter((l) => l.includes(":") && !l.startsWith("#")).map((l) => l.trim().split(":")));

export async function checkRedis() {
  const r = getClient();
  const out = [];
  try {
    const t0 = Date.now();
    await r.ping();
    const lat = Date.now() - t0;
    const i = parse(await r.info());
    out.push({ name: "redis:up", status: lat > 500 ? "WARN" : "OK", detail: `ping ${lat}ms, v${i.redis_version}, uptime ${Math.round(i.uptime_in_seconds / 3600)}h` });

    const used = Number(i.used_memory), max = Number(i.maxmemory) || Number(i.total_system_memory) || 0;
    const pct = max ? (used / max) * 100 : 0;
    out.push({ name: "redis:memory", status: pct > config.redis.memWarnPct ? "WARN" : "OK",
      detail: `${(used / 1048576).toFixed(1)}MB${max ? ` of ${(max / 1048576).toFixed(0)}MB (${pct.toFixed(1)}%)` : ""}, policy ${i.maxmemory_policy}, frag ${i.mem_fragmentation_ratio}` });

    const hits = Number(i.keyspace_hits), misses = Number(i.keyspace_misses), ev = Number(i.evicted_keys), rej = Number(i.rejected_connections);
    let evDelta = 0, rejDelta = 0, hitRatio = null, ops = Number(i.instantaneous_ops_per_sec);
    if (prev) {
      evDelta = ev - prev.ev; rejDelta = rej - prev.rej;
      const dh = hits - prev.hits, dm = misses - prev.misses;
      if (dh + dm >= config.redis.hitRatioMinOps) hitRatio = dh / (dh + dm);
    }
    prev = { ev, rej, hits, misses };
    out.push({ name: "redis:evictions", status: evDelta > 0 ? "WARN" : "OK", detail: `${evDelta} new (total ${ev}) — keys are being dropped under memory pressure when >0` });
    out.push({ name: "redis:cache-hit-ratio", status: hitRatio !== null && hitRatio < config.redis.hitRatioWarn ? "WARN" : "OK",
      detail: hitRatio === null ? "not enough traffic this interval" : `${(hitRatio * 100).toFixed(1)}% (hits ${hits}, misses ${misses})` });
    out.push({ name: "redis:clients", status: rejDelta > 0 ? "WARN" : "OK",
      detail: `connected ${i.connected_clients}, blocked ${i.blocked_clients}, rejected +${rejDelta}, ops/sec ${ops}` });
    const bad = [];
    if (i.rdb_last_bgsave_status && i.rdb_last_bgsave_status !== "ok") bad.push(`rdb: ${i.rdb_last_bgsave_status}`);
    if (i.aof_last_write_status && i.aof_last_write_status !== "ok") bad.push(`aof: ${i.aof_last_write_status}`);
    out.push({ name: "redis:persistence", status: bad.length ? "WARN" : "OK", detail: bad.join("; ") || "ok" });

    // key distribution (bounded scan, not KEYS *)
    const counts = {}; let cursor = "0", scanned = 0;
    do {
      const [c, keys] = await r.scan(cursor, "COUNT", 500);
      cursor = c; scanned += keys.length;
      for (const k of keys) { const p = k.split(":")[0] + (k.startsWith("bull:") ? ":" + k.split(":")[1] : ""); counts[p] = (counts[p] || 0) + 1; }
    } while (cursor !== "0" && scanned < 5000);
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}=${v}`).join(", ");
    const sl = await r.slowlog("GET", 3).catch(() => []);
    out.push({ name: "redis:keys", status: "OK", detail: `${await r.dbsize()} keys; top prefixes: ${top || "-"}; slowlog entries: ${sl.length}` });
  } catch (e) {
    out.push({ name: "redis:up", status: "FAIL", detail: `cannot reach Redis: ${e.message}` });
  }
  return out;
}
