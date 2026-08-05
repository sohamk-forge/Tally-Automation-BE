/*
====================================
ledgerEmbedding.js

Handles the "learn from confirmed vouchers, suggest ledgers for new
ones" flow using pgvector.

  - embedGroupKeysBatch()          -> spawns ledger_embedding_cli.py
                                       ONCE for a list of group_keys,
                                       returns vectors in the same order.
  - storeLedgerEmbedding()         -> inserts a (company_name, group_key,
                                       ledger_name, embedding) row. Called
                                       from pushVoucher.worker.js right
                                       after a voucher is confirmed
                                       SUCCESS in Tally.
  - suggestLedgersForGroupKeys()   -> given a company + a list of
                                       group_keys (already de-duplicated
                                       upstream), embeds them all in ONE
                                       python call, then does one
                                       cosine-similarity lookup per
                                       distinct group_key. Returns a map
                                       { group_key: { suggested, ledger_name, similarity } }.

voucher.routes.js and pushVoucher.worker.js import from this file.
====================================
*/

import { spawn } from "child_process";
import path from "path";
import db from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";

const SIMILARITY_THRESHOLD = 0.8;

/*
====================================
EMBEDDING — spawns ledger_embedding_cli.py ONCE for a batch of
group_keys. Same pattern as runSemanticEnrichment() in
voucher.routes.js, but for embeddings.
====================================
*/

function embedGroupKeysBatch(groupKeys) {
  return new Promise((resolve, reject) => {
    if (!groupKeys.length) return resolve([]);

   const pyFile = path.join(process.cwd(), "src", "python", "ledger_embedding_cli.py");
    const python = spawn("python", [pyFile]);

    let output = "";
    let errorOutput = "";

    python.stdout.on("data", (d) => (output += d.toString()));
    python.stderr.on("data", (d) => (errorOutput += d.toString()));

    python.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(errorOutput || "ledger_embedding_cli failed"));
      }
      try {
        const parsed = JSON.parse(output); // array of vectors, same order as input
        resolve(parsed);
      } catch (e) {
        reject(new Error(`ledger_embedding_cli parse error: ${e.message}`));
      }
    });

    python.on("error", reject);

    python.stdin.write(JSON.stringify(groupKeys));
    python.stdin.end();
  });
}

/*
====================================
WRITE PATH — store a confirmed narration-pattern -> ledger mapping.
Fail-open by design: called from the worker's success path, and an
embedding failure must never fail/rollback the voucher push itself.
====================================
*/

export async function storeLedgerEmbedding({ companyName, groupKey, ledgerName }) {
  if (!groupKey || !groupKey.trim()) return { stored: false, reason: "empty group_key" };
  if (!ledgerName || !ledgerName.trim()) return { stored: false, reason: "empty ledger_name" };

  try {
    const [vector] = await embedGroupKeysBatch([groupKey]);
    await db.query(
      `INSERT INTO ${DB_SCHEMA}.ledger_embeddings (company_name, group_key, ledger_name, embedding)
       VALUES ($1, $2, $3, $4)`,
      [companyName, groupKey, ledgerName, JSON.stringify(vector)]
    );
    return { stored: true };
  } catch (err) {
    console.error("storeLedgerEmbedding failed:", err.message);
    return { stored: false, reason: err.message };
  }
}

/*
====================================
READ PATH — BATCHED — given a company and a de-duplicated list of
group_keys, embed all of them in ONE python call, then run one
cosine-similarity lookup per distinct group_key against
${DB_SCHEMA}.ledger_embeddings, scoped to company_name.

Returns a Map keyed by group_key:
  { suggested: true,  ledger_name: "...", similarity: 0.87 }
  { suggested: false, similarity: 0.62 }               // below threshold
  { suggested: false, reason: "no history for this company yet" }
====================================
*/

export async function suggestLedgersForGroupKeys(companyName, groupKeys) {
  const distinctKeys = [...new Set(groupKeys.filter((k) => k && k.trim()))];
  const suggestionMap = new Map();

  if (!distinctKeys.length) return suggestionMap;

  let vectors;
  try {
    vectors = await embedGroupKeysBatch(distinctKeys);
  } catch (err) {
    console.error("suggestLedgersForGroupKeys embed failed:", err.message);
    for (const key of distinctKeys) {
      suggestionMap.set(key, { suggested: false, reason: "embedding failed" });
    }
    return suggestionMap;
  }

  for (let i = 0; i < distinctKeys.length; i++) {
    const key = distinctKeys[i];
    const vector = vectors[i];

    try {
      const result = await db.query(
        `SELECT ledger_name, 1 - (embedding <=> $2) AS similarity
         FROM ${DB_SCHEMA}.ledger_embeddings
         WHERE company_name = $1
         ORDER BY embedding <=> $2
         LIMIT 1`,
        [companyName, JSON.stringify(vector)]
      );

      const best = result.rows[0];
      if (!best) {
        suggestionMap.set(key, { suggested: false, reason: "no history for this company yet" });
        continue;
      }

      const similarity = Number(best.similarity);
      if (similarity < SIMILARITY_THRESHOLD) {
        suggestionMap.set(key, { suggested: false, similarity });
        continue;
      }

      suggestionMap.set(key, { suggested: true, ledger_name: best.ledger_name, similarity });

    } catch (err) {
      console.error(`suggestLedgersForGroupKeys lookup failed for "${key}":`, err.message);
      suggestionMap.set(key, { suggested: false, reason: err.message });
    }
  }

  return suggestionMap;
}