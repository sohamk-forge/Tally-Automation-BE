import pg from "pg";
import { config } from "../config.js";

let pool;
export const getPool = () =>
  (pool ||= new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 5431, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    max: 2, connectionTimeoutMillis: 8000, statement_timeout: 15000, idleTimeoutMillis: 30000,
  }).on("error", () => {}));

export async function checkPostgres() {
  const out = [];
  const p = getPool();
  try {
    const t0 = Date.now();
    await p.query("SELECT 1");
    const ms = Date.now() - t0;
    out.push({ name: "pg:up", status: ms > 1500 ? "WARN" : "OK", detail: `query ${ms}ms` });

    const { rows: [c] } = await p.query(`
      SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS used,
             current_setting('max_connections')::int AS max,
             pg_database_size(current_database()) AS size`);
    const pct = (c.used / c.max) * 100;
    out.push({ name: "pg:connections", status: pct > config.pg.connWarnPct ? "WARN" : "OK", detail: `${c.used}/${c.max} (${pct.toFixed(0)}%), db size ${(c.size / 1073741824).toFixed(2)}GB` });

    const { rows: slow } = await p.query(`
      SELECT pid, state, EXTRACT(EPOCH FROM now()-query_start)::int AS secs, left(query,80) AS q
      FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND ((state='active' AND now()-query_start > $1 * interval '1 second')
          OR (state='idle in transaction' AND now()-state_change > $2 * interval '1 second'))`,
      [config.pg.longQuerySec, config.pg.idleTxSec]);
    out.push({ name: "pg:long-queries", status: slow.length ? "WARN" : "OK",
      detail: slow.length ? slow.map((s) => `pid ${s.pid} ${s.state} ${s.secs}s: ${s.q}`).join(" | ") : "none" });

    const { rows: [lk] } = await p.query(`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`);
    out.push({ name: "pg:blocked-locks", status: lk.n > 0 ? "WARN" : "OK", detail: `${lk.n} waiting lock(s)` });
  } catch (e) {
    out.push({ name: "pg:up", status: "FAIL", detail: `cannot query Postgres: ${e.message}` });
  }
  return out;
}
