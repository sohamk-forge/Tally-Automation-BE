import { spawn } from "child_process";
import path from "path";
import db from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { backfillGroupKeyEmbeddings } from "./ledgerEmbedding.js";

export const JOB_STATUS = {
  PROCESSING: "PROCESSING",
  EXTRACTING: "EXTRACTING",
  REVIEW: "REVIEW",
  FAILED: "FAILED"
};

// The first run after a restart loads the embedding model (tens of seconds).
const SEMANTIC_CLI_TIMEOUT_MS = 180000;

// On Windows "python3" is usually the Microsoft Store stub, which exits with an error.
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");

export function deriveFallbackGroupKey(narration) {
  if (!narration) return null;

  const impsMatch = narration.match(/^(?:IMPS|NEFT|RTGS)-\d+-(.+?)-[A-Z]{3,6}-/i);
  if (impsMatch) {
    return impsMatch[1].trim().toLowerCase().replace(/\s+/g, "_");
  }

  const upiMatch = narration.match(/^UPI-(.+?)-[\w.]+@[\w]+-/i);
  if (upiMatch) {
    return upiMatch[1].trim().toLowerCase().replace(/\s+/g, "_");
  }

  return null;
}

// Rejects on any failure so the job can be marked FAILED instead of silently producing no keys.
function runSemanticCli(transactions) {
  return new Promise((resolve, reject) => {
    if (!transactions.length) return resolve([]);

    const pyFile = path.join(process.cwd(), "src", "python", "semantic_cli.py");
    const python = spawn(PYTHON_BIN, [pyFile]);

    let output = "";
    let errorOutput = "";
    let settled = false;

    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      python.kill();
      done(reject, new Error(`semantic_cli timed out after ${SEMANTIC_CLI_TIMEOUT_MS} ms`));
    }, SEMANTIC_CLI_TIMEOUT_MS);

    python.stdout.on("data", (d) => (output += d.toString()));
    python.stderr.on("data", (d) => (errorOutput += d.toString()));

    python.on("close", (code) => {
      if (code !== 0) {
        return done(reject, new Error(`semantic_cli failed: ${errorOutput.slice(-500)}`));
      }
      try {
        const parsed = JSON.parse(output);
        if (parsed?.error) return done(reject, new Error(`semantic_cli error: ${parsed.error}`));
        done(resolve, parsed);
      } catch (e) {
        done(reject, new Error(`semantic_cli parse error: ${e.message}`));
      }
    });

    python.on("error", (err) => done(reject, new Error(`semantic_cli spawn error: ${err.message}`)));

    python.stdin.write(JSON.stringify(transactions));
    python.stdin.end();
  });
}

export async function setJobStatus(companyId, fileName, status, error = null) {
  await db.query(
    `INSERT INTO ${DB_SCHEMA}.statement_jobs (company_id, file_name, status, error, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (company_id, file_name)
     DO UPDATE SET status = EXCLUDED.status, error = EXCLUDED.error, updated_at = now()`,
    [companyId, fileName, status, error]
  );
}

export async function deleteJobs(companyId, fileNames) {
  if (!fileNames.length) return;
  await db.query(
    `DELETE FROM ${DB_SCHEMA}.statement_jobs WHERE company_id = $1 AND file_name = ANY($2)`,
    [companyId, fileNames]
  );
}

async function runExtractionJob(companyId, fileName) {
  try {
    await setJobStatus(companyId, fileName, JOB_STATUS.EXTRACTING);

    const rowsRes = await db.query(
      `SELECT id, narration, group_key, merchant_name
       FROM ${DB_SCHEMA}.contra_vouchers
       WHERE company_id = $1 AND file_name = $2
         AND status IN ('WAITING_LEDGER', 'FAILED')
       ORDER BY id`,
      [companyId, fileName]
    );
    const rows = rowsRes.rows;

    if (rows.length) {
      const enriched = await runSemanticCli(
        rows.map((r) => ({ narration: String(r.narration ?? "").trim() }))
      );

      for (const [i, r] of rows.entries()) {
        const merchantName = enriched[i]?.merchant_name || null;
        let groupKey = enriched[i]?.group_key || null;
        if (!groupKey || groupKey.toLowerCase() === "unknown") {
          groupKey = deriveFallbackGroupKey(r.narration) || null;
        }

        await db.query(
          `UPDATE ${DB_SCHEMA}.contra_vouchers SET merchant_name = $1, group_key = $2 WHERE id = $3`,
          [merchantName ?? r.merchant_name ?? null, groupKey, r.id]
        );

        const vector = enriched[i]?.group_key_embedding;
        if (vector && enriched[i]?.group_key) {
          await db.query(
            `INSERT INTO ${DB_SCHEMA}.group_key_embeddings (group_key, embedding)
             VALUES ($1, $2::vector) ON CONFLICT (group_key) DO NOTHING`,
            [enriched[i].group_key, JSON.stringify(vector)]
          );
        }
      }

      // Fallback-derived keys have no embedding yet; this only spawns Python if some are missing.
      await backfillGroupKeyEmbeddings(companyId, fileName);
    }

    await setJobStatus(companyId, fileName, JOB_STATUS.REVIEW);
  } catch (err) {
    console.error(`extraction job failed for "${fileName}" (company ${companyId}):`, err.message);
    try {
      await setJobStatus(companyId, fileName, JOB_STATUS.FAILED, err.message.slice(0, 500));
    } catch (e) {
      console.error("could not record failed job status:", e.message);
    }
  }
}

// One extraction at a time so we never run several Python model loads in parallel.
let queueTail = Promise.resolve();
const queued = new Set();

export function enqueueExtraction(companyId, fileName) {
  const key = `${companyId}::${fileName}`;
  if (queued.has(key)) return;
  queued.add(key);
  queueTail = queueTail
    .then(() => runExtractionJob(companyId, fileName))
    .catch((err) => console.error("extraction queue error:", err.message))
    .finally(() => queued.delete(key));
}

export async function resumeExtractionJobs() {
  try {
    const res = await db.query(
      `SELECT company_id, file_name FROM ${DB_SCHEMA}.statement_jobs
       WHERE status IN ('PROCESSING', 'EXTRACTING')`
    );
    for (const row of res.rows) enqueueExtraction(row.company_id, row.file_name);
    if (res.rows.length) console.log(`Resuming ${res.rows.length} interrupted statement extraction job(s)`);
  } catch (err) {
    console.error("resumeExtractionJobs failed:", err.message);
  }
}
