// Read-only check, run by hand:  node scripts/verifyVoucherCounts.js <companyId>
//
// For each month it prints the vouchers saved in the database next to the vouchers Tally's XML held for the same
// periods in the last sync (app_test.sync_piece_progress), and flags months where they differ, or where a period
// failed or was never synced. It changes nothing.
import "dotenv/config";
import pkg from "pg";
const { Client } = pkg;

const companyId = Number(process.argv[2]);
if (!companyId) {
  console.error("usage: node scripts/verifyVoucherCounts.js <companyId>");
  process.exit(1);
}

const client = new Client({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

await client.connect();
try {
  const db = await client.query(
    `SELECT to_char(voucher_date, 'YYYY-MM') AS month, count(*)::int AS n
       FROM app_test.vouchers
      WHERE company_id = $1 AND deleted_at IS NULL
      GROUP BY 1 ORDER BY 1`,
    [companyId]
  );
  const pieces = await client.query(
    `SELECT to_char(from_date, 'YYYY-MM') AS month, status,
            coalesce(sum(records), 0)::int AS xml, coalesce(sum(saved), 0)::int AS saved, count(*)::int AS pieces
       FROM app_test.sync_piece_progress
      WHERE company_id = $1 AND step = 'VOUCHERS'
      GROUP BY 1, 2 ORDER BY 1, 2`,
    [companyId]
  );

  const dbBy = new Map(db.rows.map((r) => [r.month, r.n]));
  const months = new Set([...dbBy.keys(), ...pieces.rows.map((r) => r.month)]);
  let problems = 0;
  console.log("month    | in database | Tally XML (last sync) | pieces completed / failed | verdict");
  for (const month of [...months].sort()) {
    const done = pieces.rows.find((r) => r.month === month && r.status === "completed");
    const failed = pieces.rows.find((r) => r.month === month && r.status === "failed");
    const inDb = dbBy.get(month) || 0;
    const xml = done ? done.xml : 0;
    let verdict = "ok";
    if (failed) verdict = "PERIOD FAILED";
    else if (!done) verdict = "NOT SYNCED";
    else if (inDb < xml) verdict = `MISSING ${xml - inDb}`;
    else if (inDb > xml) verdict = `database has ${inDb - xml} more (older rows or still-corrupt vouchers excluded)`;
    if (verdict !== "ok") problems++;
    console.log(`${month}  | ${String(inDb).padStart(11)} | ${String(xml).padStart(21)} | ${String(done?.pieces || 0).padStart(10)} / ${failed?.pieces || 0}`.padEnd(70) + ` | ${verdict}`);
  }
  console.log(problems ? `\n${problems} month(s) need attention.` : "\nAll months match.");
} finally {
  await client.end();
}
