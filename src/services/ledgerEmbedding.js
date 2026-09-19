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
      `INSERT INTO app_test.ledger_embeddings (company_name, group_key, ledger_name, embedding)
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
app_test.ledger_embeddings, scoped to company_name.

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

  // Embeddings are cached per group_key at upload time, so this is a pure SQL lookup (no Python).
  try {
    const result = await db.query(
      `SELECT g.group_key, best.ledger_name, best.similarity
       FROM unnest($2::text[]) AS g(group_key)
       JOIN app_test.group_key_embeddings ke ON ke.group_key = g.group_key
       CROSS JOIN LATERAL (
         SELECT le.ledger_name, 1 - (le.embedding <=> ke.embedding) AS similarity
         FROM app_test.ledger_embeddings le
         WHERE le.company_name = $1
         ORDER BY le.embedding <=> ke.embedding
         LIMIT 1
       ) best`,
      [companyName, distinctKeys]
    );

    for (const row of result.rows) {
      const similarity = Number(row.similarity);
      suggestionMap.set(
        row.group_key,
        similarity < SIMILARITY_THRESHOLD
          ? { suggested: false, similarity }
          : { suggested: true, ledger_name: row.ledger_name, similarity }
      );
    }
  } catch (err) {
    console.error("suggestLedgersForGroupKeys lookup failed:", err.message);
    for (const key of distinctKeys) {
      suggestionMap.set(key, { suggested: false, reason: err.message });
    }
    return suggestionMap;
  }

  for (const key of distinctKeys) {
    if (!suggestionMap.has(key)) {
      suggestionMap.set(key, { suggested: false, reason: "no history or embedding not ready yet" });
    }
  }

  return suggestionMap;
}

/*
====================================
BACKFILL — cache embeddings for group_keys that don't have one yet
(fallback-derived keys, or rows uploaded before embeddings were cached).
Spawns Python ONCE, and only if something is actually missing.
====================================
*/

export async function backfillGroupKeyEmbeddings(companyId = null, fileName = null) {
  const params = [];
  let scope = "";
  if (companyId !== null && fileName !== null) {
    params.push(companyId, fileName);
    scope = "AND cv.company_id = $1 AND cv.file_name = $2";
  }

  const missing = await db.query(
    `SELECT DISTINCT cv.group_key
     FROM app_test.contra_vouchers cv
     LEFT JOIN app_test.group_key_embeddings ke ON ke.group_key = cv.group_key
     WHERE cv.group_key IS NOT NULL AND cv.group_key <> ''
       AND cv.status IN ('WAITING_LEDGER', 'FAILED')
       AND ke.group_key IS NULL
       ${scope}
     LIMIT 3000`,
    params
  );
  const keys = missing.rows.map((r) => r.group_key);
  if (!keys.length) return 0;

  const vectors = await embedGroupKeysBatch(keys);
  for (let i = 0; i < keys.length; i++) {
    await db.query(
      `INSERT INTO app_test.group_key_embeddings (group_key, embedding)
       VALUES ($1, $2::vector) ON CONFLICT (group_key) DO NOTHING`,
      [keys[i], JSON.stringify(vectors[i])]
    );
  }
  return keys.length;
}
