import { config } from "../config.js";
import { getPool } from "./postgres.js";

const S = "app_test";
const q = (sql, p) => getPool().query(sql, p).then((r) => r.rows);

export async function checkPipeline() {
  const out = [], P = config.pipeline;
  const run = async (name, fn) => {
    try { out.push(...(await fn())); } catch (e) { out.push({ name, status: "FAIL", detail: `query failed: ${e.message}` }); }
  };

  await run("pipeline:connector-jobs", async () => {
    const [r] = await q(`
      SELECT count(*) FILTER (WHERE status='pending' AND created_at < now() - $1*interval '1 minute')::int AS stuck_pending,
             count(*) FILTER (WHERE status='claimed' AND claimed_at < now() - $2*interval '1 minute')::int AS stuck_claimed,
             count(*) FILTER (WHERE status='failed' AND updated_at > now() - $3*interval '1 hour')::int AS failed_recent,
             count(*) FILTER (WHERE status='pending')::int AS pending
      FROM ${S}.connector_jobs`, [P.pendingMin, P.claimedMin, P.failedRecentHours]);
    const bad = r.stuck_pending || r.stuck_claimed || r.failed_recent >= P.failedRecentWarn;
    return [{ name: "pipeline:connector-jobs", status: bad ? "WARN" : "OK",
      detail: `pending ${r.pending} (stuck >${P.pendingMin}m: ${r.stuck_pending}), claimed stuck >${P.claimedMin}m: ${r.stuck_claimed}, failed last ${P.failedRecentHours}h: ${r.failed_recent}` }];
  });

  await run("pipeline:connector-heartbeat", async () => {
    const rows = await q(`SELECT machine_name, tally_connected, EXTRACT(EPOCH FROM now()-last_seen)/60 AS min FROM ${S}.connector_machines`);
    const alive = rows.filter((m) => m.min < P.connectorOfflineMin);
    const pendingRows = await q(`SELECT count(*)::int AS n FROM ${S}.connector_jobs WHERE status='pending'`);
    const offlineWithWork = alive.length === 0 && pendingRows[0].n > 0;
    return [{ name: "pipeline:connector-heartbeat", status: offlineWithWork ? "WARN" : "OK",
      detail: rows.map((m) => `${m.machine_name}: seen ${Math.round(m.min)}m ago, tally ${m.tally_connected ? "up" : "down"}`).join("; ") + (offlineWithWork ? " | no connector online but jobs are pending" : "") }];
  });

  await run("pipeline:missing-ledgers", async () => {
    const rows = await q(`SELECT company_id, count(*)::int AS n FROM ${S}.invoice_extractions WHERE sync_status='ledger_missing' GROUP BY 1`);
    const total = rows.reduce((a, r) => a + r.n, 0);
    const names = await q(`SELECT DISTINCT e.company_id, m->>'ledger' AS ledger FROM ${S}.invoice_extractions e,
        LATERAL jsonb_array_elements(CASE WHEN left(e.error_message,1)='{' AND (e.error_message::jsonb ? 'missing_ledgers') THEN e.error_message::jsonb->'missing_ledgers' ELSE '[]'::jsonb END) m
        WHERE e.sync_status='ledger_missing' LIMIT 10`).catch(() => []);
    return [{ name: "pipeline:missing-ledgers", status: total >= P.ledgerMissingWarn ? "WARN" : "OK",
      detail: total ? `${total} invoice(s) blocked: ` + rows.map((r) => `company ${r.company_id}=${r.n}`).join(", ") + (names.length ? ` | ledgers: ${names.map((x) => x.ledger).join(", ")}` : "") : "none" }];
  });

  await run("pipeline:bank-vouchers", async () => {
    const [r] = await q(`SELECT count(*) FILTER (WHERE status='WAITING_LEDGER')::int AS waiting,
        count(*) FILTER (WHERE status='FAILED' AND updated_at > now() - $1*interval '1 hour')::int AS failed_recent
        FROM ${S}.contra_vouchers`, [P.failedRecentHours]);
    return [{ name: "pipeline:bank-vouchers", status: r.waiting >= P.waitingLedgerWarn || r.failed_recent >= P.failedRecentWarn ? "WARN" : "OK",
      detail: `WAITING_LEDGER ${r.waiting}, FAILED last ${P.failedRecentHours}h ${r.failed_recent}` }];
  });

  await run("pipeline:mapping-drift", async () => {
    const rows = await q(`
      WITH m AS (
        SELECT company_id, k AS field, v AS ledger FROM ${S}.company_ledger_mappings,
          LATERAL (VALUES ('cgst_ledger',cgst_ledger),('sgst_ledger',sgst_ledger),('igst_ledger',igst_ledger),
                          ('purchase_ledger',purchase_ledger),('tds_ledger',tds_ledger),('cess_ledger',cess_ledger),
                          ('rounded_off_ledger',rounded_off_ledger),('discount_ledger',discount_ledger)) t(k,v)
        WHERE v IS NOT NULL AND btrim(v) <> '')
      SELECT m.company_id, m.field, m.ledger FROM m
      WHERE NOT EXISTS (SELECT 1 FROM ${S}.all_ledger_details l
                        WHERE l.company_id = m.company_id AND l.deleted_at IS NULL AND lower(btrim(l.ledger_name)) = lower(btrim(m.ledger)))
      ORDER BY 1,2`);
    return [{ name: "pipeline:mapping-drift", status: rows.length ? "WARN" : "OK",
      detail: rows.length ? rows.slice(0, 10).map((r) => `company ${r.company_id}.${r.field}="${r.ledger}"`).join("; ") + (rows.length > 10 ? ` (+${rows.length - 10} more)` : "") + " — mapped ledger missing in Tally data" : "all mapped ledgers exist" }];
  });

  await run("pipeline:ledger-sync-age", async () => {
    const rows = await q(`SELECT company_id, EXTRACT(EPOCH FROM now()-max(updated_at))/3600 AS h FROM ${S}.all_ledger_details GROUP BY 1`);
    const stale = rows.filter((r) => r.h > 168);
    return [{ name: "pipeline:ledger-sync-age", status: stale.length ? "WARN" : "OK",
      detail: stale.length ? `no ledger updates >7d for company ${stale.map((s) => s.company_id).join(", ")}` : "recent" }];
  });
  return out;
}
