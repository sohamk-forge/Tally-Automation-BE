// Errors that mean "the connection to Postgres broke or was garbled", not "this data is wrong".
// Seen during a long sync over an unreliable network: "Connection terminated unexpectedly", timeouts while
// connecting, and a protocol violation (SQLSTATE 08P01, routine SocketBackend) that Postgres reports to the
// client as "invalid input syntax for type json" because the message it received was damaged in transit.
// Retrying the same statement on a fresh connection is safe for the callers that use this.

import { isConnectionError } from "../db/failoverPool.js";

export function isTransientDbError(err) {
  if (!err) return false;
  if (isConnectionError(err)) return true;
  if (err.code === "08P01" || err.routine === "SocketBackend") return true;
  return /invalid input syntax for type json|malformed array literal|invalid byte sequence|Connection terminated|ECONNRESET|socket hang up|read ECONN|write EPIPE|timeout exceeded when trying to connect/i.test(
    String(err.message || "")
  );
}

export const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, retrying it on a transient database error (up to `attempts` times in total, with a growing pause).
 * Any other error is thrown straight away.
 */
export async function withDbRetry(fn, { attempts = 3, baseDelayMs = 1000, label = "db call" } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientDbError(err) || attempt === attempts) throw err;
      console.log(`⚠️ ${label}: transient database error (${err.message}) - retry ${attempt}/${attempts - 1}`);
      await sleepMs(baseDelayMs * attempt);
    }
  }
  throw lastError;
}
