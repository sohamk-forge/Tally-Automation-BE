import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { needsAppNumber } from "./voucherNumbering.service.js";
import { normalizeNumbering } from "./companyProfileRules.js";

/*
  Numbering profile: for each voucher type of a company, how is it numbered?
    - the Tally setting (Automatic / Automatic (Manual Override) / Manual)
    - what the synced vouchers actually look like (format, gaps, duplicates)
  The setting says what Tally allows; the vouchers show what people really do.
*/

const REPORT_BASES = ["sales", "purchase", "receipt", "payment", "contra", "journal"];

function parse(str) {
  const s = String(str ?? "").trim();
  const m = /^(.*?)(\d+)(\D*)$/.exec(s);
  if (!m) return { raw: s, kind: s ? "text" : "empty" };
  const kind = !m[1] && !m[3] ? "numeric" : "prefixed";
  return { raw: s, kind, prefix: m[1], digits: m[2], suffix: m[3], value: Number(m[2]) };
}

// Indian financial year label for a date, e.g. "2025-26"
function fyLabel(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "unknown";
  const y = dt.getFullYear();
  const start = dt.getMonth() + 1 >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

// rows: [{ voucher_number, voucher_date }] of ONE voucher type
export function analyzeNumbers(rows) {
  const parsed = rows.map(r => ({ ...parse(r.voucher_number), date: r.voucher_date }));
  const total = parsed.length;
  if (!total) return { voucher_count: 0, format: null, consistency_pct: null, gaps: 0, duplicates: 0, last_number: null, by_year: [], looks_manual: false };

  // Format signature: prefix + {n} + suffix, with number width
  const sig = p => p.kind === "text" || p.kind === "empty"
    ? "(no number)"
    : `${p.prefix}{n}${p.suffix}`;
  const sigCounts = new Map();
  for (const p of parsed) sigCounts.set(sig(p), (sigCounts.get(sig(p)) || 0) + 1);
  const [domSig, domCount] = [...sigCounts].sort((a, b) => b[1] - a[1])[0];
  const dominant = parsed.filter(p => sig(p) === domSig);
  const widths = new Set(dominant.filter(p => p.digits).map(p => p.digits.length));
  const consistency = Math.round((domCount / total) * 100);

  // Per financial year, within the dominant format: range, gaps, duplicates
  const byYear = new Map();
  for (const p of dominant) {
    if (p.value === undefined) continue;
    const y = fyLabel(p.date);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(p.value);
  }
  let gaps = 0, duplicates = 0;
  const years = [...byYear].sort((a, b) => a[0].localeCompare(b[0])).map(([year, vals]) => {
    const distinct = new Set(vals);
    const min = Math.min(...vals), max = Math.max(...vals);
    const g = Math.max(0, (max - min + 1) - distinct.size);
    const d = vals.length - distinct.size;
    gaps += g; duplicates += d;
    return { year, count: vals.length, first: min, last: max, gaps: g, duplicates: d, restarts_at_one: min <= 1 };
  });

  const latest = [...parsed].filter(p => p.date).sort((a, b) => new Date(b.date) - new Date(a.date))[0];

  return {
    voucher_count: total,
    // e.g. "FR/0000" for fixed-width numbers, "FR/#" when the width varies
    format: domSig === "(no number)" ? domSig : domSig.replace("{n}", widths.size === 1 && [...widths][0] > 1 ? "0".repeat([...widths][0]) : "#"),
    format_pattern: domSig,
    fixed_width: widths.size === 1 ? [...widths][0] : null,
    consistency_pct: consistency,
    gaps,
    duplicates,
    last_number: latest?.raw ?? null,
    by_year: years,
    // Mixed formats or many un-numbered / free-text numbers look hand-typed
    looks_manual: consistency < 80
  };
}

export async function getNumberingProfile(companyId) {
  const types = await pool.query(
    `SELECT name, base_type, numbering_method
       FROM ${DB_SCHEMA}.voucher_types
      WHERE company_id = $1 AND is_active = true AND base_type = ANY($2::text[])
      ORDER BY base_type, name`,
    [companyId, REPORT_BASES]
  );
  const vouchers = await pool.query(
    `SELECT voucher_type, voucher_number, voucher_date
       FROM ${DB_SCHEMA}.vouchers
      WHERE company_id = $1 AND deleted_at IS NULL`,
    [companyId]
  );

  const byType = new Map();
  for (const v of vouchers.rows) {
    const key = String(v.voucher_type || "").trim().toLowerCase();
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(v);
  }

  return types.rows.map(t => ({
    voucher_type: t.name,
    base_type: t.base_type,
    numbering_method: t.numbering_method || null,
    numbering_mode: normalizeNumbering(t.numbering_method),
    needs_app_number: needsAppNumber(t.numbering_method),
    ...analyzeNumbers(byType.get(t.name.trim().toLowerCase()) || [])
  }));
}
