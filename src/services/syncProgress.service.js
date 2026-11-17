// =========================================
// src/services/syncProgress.service.js
//
// Remembers which date pieces of a sync step finished (app_test.sync_piece_progress), so a rerun after a failed
// sync only redoes what is missing instead of everything.
//
// Resume rule: when the previous run left any piece of this step incomplete (failed, or never reached), the pieces
// it completed within SYNC_RESUME_WINDOW_HOURS (default 12) are skipped. When every piece already completed, the
// next run refetches everything, exactly like a normal sync. SYNC_FORCE_FULL=true always refetches.
//
// Nothing here may ever break a sync: any database problem (including the table not existing yet) just turns
// resume off.
// =========================================

import pool from "../db/index.js";

const WINDOW_HOURS = Number(process.env.SYNC_RESUME_WINDOW_HOURS || 12);
const key = (fromDate, toDate) => `${fromDate}|${toDate}`;

/**
 * @returns Set of "fromDate|toDate" keys (YYYYMMDD) to skip; empty when resume does not apply.
 */
export async function loadResumeKeys(companyId, step, pieces) {
  try {
    if (process.env.SYNC_FORCE_FULL === "true" || !companyId || !pieces?.length) return new Set();

    const { rows } = await pool.query(
      `SELECT to_char(from_date, 'YYYYMMDD') AS f, to_char(to_date, 'YYYYMMDD') AS t
         FROM app_test.sync_piece_progress
        WHERE company_id = $1 AND step = $2 AND status = 'completed'
          AND completed_at > NOW() - make_interval(hours => $3)`,
      [companyId, step, WINDOW_HOURS]
    );
    const completed = new Set(rows.map((r) => key(r.f, r.t)));
    const wanted = pieces.map((p) => key(p.fromDate, p.toDate));
    const allDone = wanted.every((k) => completed.has(k));
    if (allDone) return new Set(); // previous run finished this step completely: a normal full refetch
    return new Set(wanted.filter((k) => completed.has(k)));
  } catch (err) {
    console.log(`⚠️ sync progress: could not read resume state (${err.message}) - refetching everything`);
    return new Set();
  }
}

export const pieceKey = key;

export async function recordPiece(companyId, step, piece, status, summary, errorMessage, jobLogId) {
  try {
    if (!companyId || !piece?.fromDate || !piece?.toDate) return;
    const xmlCount = Number.isFinite(Number(summary?.xmlCount)) ? Number(summary.xmlCount) : null;
    const saved = summary ? (Number(summary.inserted) || 0) + (Number(summary.updated) || 0) : null;
    await pool.query(
      `INSERT INTO app_test.sync_piece_progress
         (company_id, step, from_date, to_date, status, records, saved, error, completed_at, job_log_id)
       VALUES ($1, $2, to_date($3, 'YYYYMMDD'), to_date($4, 'YYYYMMDD'), $5, $6, $7, $8, NOW(), $9)
       ON CONFLICT (company_id, step, from_date, to_date)
       DO UPDATE SET status = EXCLUDED.status, records = EXCLUDED.records, saved = EXCLUDED.saved,
                     error = EXCLUDED.error, completed_at = NOW(), job_log_id = EXCLUDED.job_log_id`,
      [companyId, step, piece.fromDate, piece.toDate, status, xmlCount, saved, errorMessage ? String(errorMessage).slice(0, 500) : null, jobLogId || null]
    );
  } catch (err) {
    console.log(`⚠️ sync progress: could not record ${step} ${piece?.label} (${err.message})`);
  }
}
