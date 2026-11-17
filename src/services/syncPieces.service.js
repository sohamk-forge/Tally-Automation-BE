// =========================================
// src/services/syncPieces.service.js
//
// Runs the date pieces of one sync step (e.g. the 24 half-month voucher requests) one at a time.
//
//  - A piece that fails with a connection-type error is retried (a dropped or reset local connection says
//    nothing about the data, and every dated route is idempotent).
//  - A piece that still fails does NOT end the step: it is recorded, and the remaining pieces still run, so one
//    bad period can no longer stop every later period from ever being tried.
//  - "The connector is not picking up requests" still stops everything at once.
//  - Pieces can be skipped (resume): the caller says which ones already completed.
//
// The Tally-facing behaviour is unchanged: one request at a time, with the pause between real requests.
// =========================================

import { isTransientDbError } from "../utils/transientDbError.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);

const messageOf = (err) => String(err?.response?.data?.message || err?.message || "");

/** True when failing the same request again is reasonable: a connection broke, or the DB reported a transient fault. */
export function isRetryablePieceError(err, connectorDownCode = null) {
  const msg = messageOf(err);
  if (connectorDownCode && msg.includes(connectorDownCode)) return false;
  if (/timeout of \d+ms exceeded|timed out/i.test(msg)) return false; // a slow Tally is not helped by asking again
  if (!err?.response && (NETWORK_CODES.has(err?.code) || /socket hang up|ECONNRESET|EPIPE|read ECONN/i.test(msg))) return true;
  if (err?.response?.status >= 500 && isTransientDbError({ message: msg })) return true;
  return false;
}

/**
 * @param calls              [{ piece | null, params }]
 * @param callPiece          async (call) => axios-like response ({ data: { summary } })
 * @param pauseMs            pause between two real requests (not before the first, not for skipped pieces)
 * @param continueOnFailure  keep going after a piece fails for good (false for single-call steps: rethrow)
 * @param connectorDownCode  error text that must stop the whole step
 * @param shouldSkip         async (piece) => boolean
 * @param onPieceDone        async (piece, "completed" | "failed", summary, errorMessage)
 * @returns { summaries, failedPieces: [{label, fromDate, toDate, error}], skipped }
 */
export async function runPieces({
  calls,
  callPiece,
  pauseMs = 0,
  attempts = 3,
  retryDelayMs = 5000,
  continueOnFailure = true,
  connectorDownCode = null,
  shouldSkip = null,
  onPieceDone = null,
  log = () => {}
}) {
  const summaries = [];
  const failedPieces = [];
  let skipped = 0;
  let made = 0;

  for (const call of calls) {
    const piece = call.piece;

    if (piece && shouldSkip && (await shouldSkip(piece))) {
      skipped++;
      log(`skipping ${piece.label} (${piece.fromDate} -> ${piece.toDate}): already completed in the previous run`);
      continue;
    }

    if (made > 0 && pauseMs > 0) await sleep(pauseMs);
    made++;

    let summary = null;
    let lastError = null;
    let ok = false;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await callPiece(call);
        summary = response?.data?.summary || null;
        ok = true;
        break;
      } catch (err) {
        lastError = err;
        if (attempt < attempts && isRetryablePieceError(err, connectorDownCode)) {
          log(`${piece ? piece.label : "request"} hit ${err.code || messageOf(err)} - retry ${attempt}/${attempts - 1}`);
          await sleep(retryDelayMs * attempt);
          continue;
        }
        break;
      }
    }

    if (ok) {
      summaries.push(summary);
      if (piece && onPieceDone) await onPieceDone(piece, "completed", summary, null);
      continue;
    }

    const message = messageOf(lastError);
    if (piece && onPieceDone) await onPieceDone(piece, "failed", null, message);

    const connectorDown = connectorDownCode && message.includes(connectorDownCode);
    if (connectorDown || !continueOnFailure) {
      // same wording as before: say which period failed; earlier periods are already saved
      if (piece && calls.length > 1) lastError.message = `FY ${piece.label}: ${message}`;
      throw lastError;
    }

    failedPieces.push({ label: piece?.label ?? null, fromDate: piece?.fromDate ?? null, toDate: piece?.toDate ?? null, error: message });
    log(`${piece?.label ?? "request"} failed for good (${message}) - continuing with the next period`);
  }

  return { summaries, failedPieces, skipped };
}
