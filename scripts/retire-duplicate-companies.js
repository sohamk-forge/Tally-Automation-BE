/**
 * Retire duplicate company rows for the same Tally business.
 *
 * Usage (from Tally-Automation-BE):
 *   node scripts/retire-duplicate-companies.js --auto [--threshold 0.9] [--min-ledgers 20] [--apply]
 *   node scripts/retire-duplicate-companies.js --group 5:3,15 [--group 9:11,13] [--apply]
 *   node scripts/retire-duplicate-companies.js --undo scripts/output/<manifest>.json
 *
 * --auto                                    detect groups for every user from ledger overlap (no
 *                                           name matching) and pick each survivor by connector
 *                                           binding, then data volume, then recent sync;
 *                                           anything ambiguous is listed for review, not grouped
 * --group <survivor>:<loser>[,<loser>...]   one or more groups, chosen by hand
 * --apply                                   commit; without it everything is rolled back (dry run)
 * --undo <manifest>                         reverse an applied run using its manifest
 *
 * What it does per group, in one transaction:
 *   1. Moves connector API keys and pairing tokens to the survivor, so later syncs land there.
 *   2. Moves app-created rows (challans, quotations, sites, settings, mappings, ...) to the
 *      survivor. Rows that would clash with an existing survivor row are left where they are
 *      and reported. Rows are moved (company_id updated), not copied, because challans and
 *      quotations have child tables and links that point at their ids.
 *   3. Sets archived_at / merged_into_company_id on the losers. Nothing is deleted.
 * Data that comes from Tally (vouchers, ledgers, groups, stock ...) is NOT touched: it must be
 * re-synced into the survivor.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import pool from "../src/db/index.js";

const S = "app_test";

// key: null = move every row; [] = one row per company; [cols] = unique per (company_id, cols)
const ACCESS_TABLES = [
  { table: "connector_api_keys", key: null },
  { table: "connector_pairing_tokens", key: null },
  { table: "company_members", key: ["user_id"] },
  { table: "user_companies", key: ["user_id"] },
];

const APP_TABLES = [
  { table: "customer_sites", key: null },
  { table: "delivery_persons", key: null },
  { table: "challans", key: ["challan_number"] },
  { table: "quotations", key: ["quotation_number"] },
  { table: "contra_vouchers", key: null },
  { table: "invoice_extractions", key: ["invoice_no"] },
  { table: "sales_invoice_extractions", key: ["invoice_no"] },
  { table: "push_ledger", key: null },
  { table: "push_stock_item", key: null },
  { table: "push_bank", key: null },
  { table: "bank_od_accounts", key: null },
  { table: "company_purchase_sales_ledgers", key: null },
  { table: "challan_settings", key: [] },
  { table: "company_details", key: [] },
  { table: "company_ledger_mappings", key: [] },
  { table: "company_sales_ledger_mappings", key: [] },
  { table: "company_role_permissions", key: ["role", "page_key"] },
  { table: "company_feature_flags", key: ["feature_key"] },
  { table: "vendor_gstin_mappings", key: ["vendor_code"] },
];

const HANDLED = new Set([...ACCESS_TABLES, ...APP_TABLES].map((t) => t.table));

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const auto = args.includes("--auto");
let threshold = 0.9; // share of the smaller company's ledgers that the other also has
let minLedgers = 20; // companies with fewer ledgers give no reliable evidence
const groups = [];
let undoFile = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--threshold") threshold = Number(args[++i]);
  else if (args[i] === "--min-ledgers") minLedgers = Number(args[++i]);
  else if (args[i] === "--group") {
    const [s, l] = String(args[++i] || "").split(":");
    const survivor = Number(s);
    const losers = String(l || "").split(",").map(Number).filter(Boolean);
    if (!survivor || losers.length === 0 || losers.includes(survivor)) {
      console.error(`Bad --group value: ${args[i]}`);
      process.exit(1);
    }
    groups.push({ survivor, losers });
  } else if (args[i] === "--undo") {
    undoFile = args[++i];
  }
}

const hasColumn = async (client, table, col) => {
  const r = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3`,
    [S, table, col]
  );
  return r.rowCount > 0;
};

/**
 * Detect duplicate groups without relying on company names.
 * Two live companies with the same admin owner are the same Tally company when their ledger
 * names overlap heavily (share of the smaller ledger set present in the other >= threshold).
 * Overlap is transitive within an owner. Companies with too few ledgers, or only partial
 * overlap, are reported for manual review and never grouped automatically.
 * Survivor = the row the connector is bound to (most pairing tokens), then the one with the most
 * vouchers, then the most recently synced, then the highest id.
 */
async function detectGroups(client, log) {
  const owners = await client.query(
    `SELECT m.user_id, array_agg(m.company_id ORDER BY m.company_id) ids
       FROM ${S}.company_members m
       JOIN ${S}.companies c ON c.id = m.company_id AND c.archived_at IS NULL
      WHERE m.role = 'admin'
      GROUP BY m.user_id HAVING COUNT(*) > 1`
  );
  const found = [];
  const review = [];
  for (const { user_id, ids } of owners.rows) {
    const rows = await client.query(
      `SELECT company_id, lower(trim(ledger_name)) n FROM ${S}.all_ledger_details
        WHERE company_id = ANY($1) AND ledger_name IS NOT NULL GROUP BY 1, 2`,
      [ids]
    );
    const sets = new Map(ids.map((id) => [id, new Set()]));
    rows.rows.forEach((r) => sets.get(r.company_id).add(r.n));

    // union-find over strong links
    const parent = new Map(ids.map((id) => [id, id]));
    const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
    const best = new Map(); // best partner overlap per company, for the review list
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = sets.get(ids[i]), b = sets.get(ids[j]);
        const small = Math.min(a.size, b.size);
        if (small < minLedgers) continue;
        let inter = 0;
        for (const n of a) if (b.has(n)) inter++;
        const contain = inter / small;
        for (const [x, y] of [[ids[i], ids[j]], [ids[j], ids[i]]]) {
          if (!best.has(x) || best.get(x).contain < contain) best.set(x, { with: y, contain });
        }
        if (contain >= threshold) parent.set(find(ids[i]), find(ids[j]));
      }
    }
    const comps = new Map();
    for (const id of ids) {
      const r = find(id);
      if (!comps.has(r)) comps.set(r, []);
      comps.get(r).push(id);
    }
    for (const members of comps.values()) {
      if (members.length === 1) {
        const id = members[0];
        const b = best.get(id);
        review.push({
          user_id, id,
          why: sets.get(id).size < minLedgers
            ? `only ${sets.get(id).size} ledgers, not enough evidence`
            : `best overlap ${(b?.contain * 100 || 0).toFixed(0)}% with company ${b?.with ?? "-"}, below ${threshold * 100}%`,
        });
        continue;
      }
      const stats = await client.query(
        `SELECT c.id,
                (SELECT MAX(updated_at) FROM ${S}.vouchers v WHERE v.company_id = c.id) last_sync,
                (SELECT COUNT(*) FROM ${S}.vouchers v WHERE v.company_id = c.id)::int vouchers,
                (SELECT COUNT(*) FROM ${S}.connector_pairing_tokens t WHERE t.company_id = c.id)::int tokens
           FROM ${S}.companies c WHERE c.id = ANY($1)`,
        [members]
      );
      const rank = stats.rows.sort((x, y) =>
        y.tokens - x.tokens ||
        y.vouchers - x.vouchers ||
        (y.last_sync?.getTime?.() ?? 0) - (x.last_sync?.getTime?.() ?? 0) ||
        y.id - x.id);
      found.push({
        user_id,
        survivor: rank[0].id,
        losers: rank.slice(1).map((r) => r.id),
        evidence: rank.map((r) => `${r.id}: ${r.vouchers} vouchers, ${r.tokens} tokens, last sync ${r.last_sync ? r.last_sync.toISOString().slice(0, 10) : "never"}`),
      });
    }
  }
  log(`Auto-detected ${found.length} group(s) (threshold ${threshold * 100}%, min ${minLedgers} ledgers):`);
  for (const g of found) {
    log(` user ${g.user_id}: survivor ${g.survivor} <- ${g.losers.join(", ")}`);
    g.evidence.forEach((e) => log(`    ${e}`));
  }
  if (review.length) {
    log(`Not grouped, needs a person to review:`);
    review.forEach((r) => log(` user ${r.user_id}: company ${r.id}, ${r.why}`));
  }
  return found;
}

async function validateGroup(client, { survivor, losers }) {
  const ids = [survivor, ...losers];
  const c = await client.query(
    `SELECT id, name, archived_at FROM ${S}.companies WHERE id = ANY($1)`,
    [ids]
  );
  if (c.rowCount !== ids.length) throw new Error(`Some companies in ${ids} do not exist`);
  const archived = c.rows.filter((r) => r.archived_at);
  if (archived.length) throw new Error(`Already archived: ${archived.map((r) => r.id)}`);
  // every row in the group must share one owner (admin member)
  const owner = await client.query(
    `SELECT user_id FROM ${S}.company_members
      WHERE company_id = ANY($1) AND role = 'admin'
      GROUP BY user_id HAVING COUNT(DISTINCT company_id) = $2`,
    [ids, ids.length]
  );
  if (owner.rowCount === 0) {
    throw new Error(`No single admin user owns all of ${ids}; refusing (different users are separate tenants)`);
  }
  return c.rows.find((r) => r.id === survivor);
}

async function moveTable(client, { table, key }, { survivor, losers }, survivorName, manifest, log) {
  const hasName = await hasColumn(client, table, "company_name");
  let where = `company_id = ANY($1)`;
  let sql;
  if (key === null) {
    sql = `SELECT id, company_id${hasName ? ", company_name" : ""} FROM ${S}.${table} t WHERE ${where}`;
  } else {
    const distinctOn = key.length ? `DISTINCT ON (${key.map((k) => `t.${k}`).join(",")})` : "";
    const notExists = key.length
      ? key.map((k) => `x.${k} IS NOT DISTINCT FROM t.${k}`).join(" AND ")
      : "TRUE";
    sql = `SELECT ${distinctOn} id, company_id${hasName ? ", company_name" : ""}
             FROM ${S}.${table} t
            WHERE ${where}
              AND NOT EXISTS (SELECT 1 FROM ${S}.${table} x WHERE x.company_id = $2 AND ${notExists})
            ORDER BY ${key.length ? key.map((k) => `t.${k}`).join(",") + "," : ""} id
            ${key.length ? "" : "LIMIT 1"}`;
  }
  const params = key === null ? [losers] : [losers, survivor];
  const cand = await client.query(sql, params);
  const ids = cand.rows.map((r) => r.id);
  if (ids.length) {
    await client.query(
      `UPDATE ${S}.${table} SET company_id = $1${hasName ? ", company_name = $3" : ""} WHERE id = ANY($2)`,
      hasName ? [survivor, ids, survivorName] : [survivor, ids]
    );
    manifest.moves.push({
      table,
      survivor,
      rows: cand.rows.map((r) => ({ id: r.id, company_id: r.company_id, company_name: r.company_name ?? null })),
    });
  }
  const left = await client.query(
    `SELECT COUNT(*)::int n FROM ${S}.${table} WHERE company_id = ANY($1)`,
    [losers]
  );
  log(`  ${table.padEnd(34)} moved ${String(ids.length).padStart(4)}   left behind ${left.rows[0].n}`);
}

async function runGroup(client, group, manifest, log) {
  const survivorRow = await validateGroup(client, group);
  log(`\nGroup: survivor ${group.survivor} (${survivorRow.name}) <- retire ${group.losers.join(", ")}`);

  log(" Access rows");
  for (const t of ACCESS_TABLES) await moveTable(client, t, group, survivorRow.name, manifest, log);
  log(" App-created rows");
  for (const t of APP_TABLES) await moveTable(client, t, group, survivorRow.name, manifest, log);

  // Report data that stays on the retired rows and must be re-synced from Tally
  const all = await client.query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema=$1 AND column_name='company_id' AND table_name <> 'companies' ORDER BY 1`,
    [S]
  );
  log(" Left on retired rows (re-sync from Tally into the survivor):");
  for (const { table_name } of all.rows) {
    if (HANDLED.has(table_name)) continue;
    const r = await client.query(
      `SELECT COUNT(*)::int n FROM ${S}."${table_name}" WHERE company_id = ANY($1)`,
      [group.losers]
    );
    if (r.rows[0].n) log(`  ${table_name.padEnd(34)} ${r.rows[0].n}`);
  }

  await client.query(
    `UPDATE ${S}.companies SET archived_at = NOW(), merged_into_company_id = $1 WHERE id = ANY($2)`,
    [group.survivor, group.losers]
  );
  manifest.archived.push({ survivor: group.survivor, losers: group.losers });
  log(` Archived ${group.losers.join(", ")}`);
}

async function undo(file) {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const m of manifest.moves.slice().reverse()) {
      const hasName = await hasColumn(client, m.table, "company_name");
      for (const r of m.rows) {
        await client.query(
          `UPDATE ${S}.${m.table} SET company_id = $1${hasName ? ", company_name = $4" : ""}
            WHERE id = $2 AND company_id = $3`,
          hasName ? [r.company_id, r.id, m.survivor, r.company_name] : [r.company_id, r.id, m.survivor]
        );
      }
    }
    for (const a of manifest.archived) {
      await client.query(
        `UPDATE ${S}.companies SET archived_at = NULL, merged_into_company_id = NULL WHERE id = ANY($1)`,
        [a.losers]
      );
    }
    await client.query("COMMIT");
    console.log(`Undo complete from ${file}`);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function main() {
  if (undoFile) return undo(undoFile);
  if (groups.length === 0 && !auto) {
    console.error("Give --auto, or at least one --group <survivor>:<loser,...> (see header of this file).");
    process.exit(1);
  }
  const client = await pool.connect();
  const lines = [];
  const log = (s) => { lines.push(s); console.log(s); };
  const manifest = { createdAt: new Date().toISOString(), moves: [], archived: [] };
  try {
    await client.query("BEGIN");
    if (auto) groups.push(...(await detectGroups(client, log)));
    if (groups.length === 0) log("\nNothing to do.");
    for (const g of groups) await runGroup(client, g, manifest, log);
    if (apply) {
      await client.query("COMMIT");
      const dir = path.resolve("scripts/output");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `retire-${Date.now()}.json`);
      fs.writeFileSync(file, JSON.stringify(manifest, null, 1));
      log(`\nAPPLIED. Undo manifest: ${file}`);
    } else {
      await client.query("ROLLBACK");
      log("\nDRY RUN: everything rolled back. Re-run with --apply to commit.");
    }
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("\nFAILED, rolled back:", e.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

main().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
