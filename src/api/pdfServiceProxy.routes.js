import http from "node:http";
import https from "node:https";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { readDateWindow, dmyToIso, overlapsWindow } from "../utils/dateWindow.js";

/**
 * Reverse proxy for the bank-statement PDF/OCR service (FastAPI, port 9001).
 *
 * That service lives on a private LAN address (192.168.0.14), but the
 * frontend is served from the public IP, so browsers outside the LAN timed
 * out on /banks, /documents, /upload etc. Routing through this API keeps
 * 9001 private and puts the calls behind the normal session check.
 *
 * Mounted BEFORE express.json() in app.js so request bodies (multipart
 * statement uploads, JSON /reconcile) are still unread streams here and
 * get piped through untouched.
 */

const target = new URL(process.env.PDF_SERVICE_URL || "http://192.168.0.14:9001");
const transport = target.protocol === "https:" ? https : http;

// Hop-by-hop headers plus the upstream's own CORS headers: the PDF service
// answers with `Access-Control-Allow-Origin: *`, which would clash with the
// credentialed CORS headers app.js has already set on this response.
const STRIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
]);

// Session/cookie headers are for this API only — never forward them.
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "cookie",
  "authorization",
  "origin",
  "referer",
  "st-auth-mode",
  "rid",
  "fdi-version",
]);

// GET /documents?company_id=..[&from=YYYY-MM-DD&to=YYYY-MM-DD]: the statement list. The PDF service only knows
// company_id and leaves each document's start/end date blank, so the answer is read here to fill the period in
// (from the transactions it extracted) and, when a window is given, to narrow it to a financial year.
// Returns null for every other request, which is proxied untouched.
function documentList(req) {
  if (req.method !== "GET") return null;
  const url = new URL(req.url, "http://proxy");
  if (url.pathname !== "/documents") return null;
  const asked = readDateWindow(Object.fromEntries(url.searchParams));
  url.searchParams.delete("from");
  url.searchParams.delete("to");
  return { window: asked && !asked.error ? asked : null, upstreamPath: `${url.pathname}${url.search}` };
}

const isoToDmy = (iso) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

// Documents with no period get one from their extracted transactions (earliest and latest date). Never throws:
// without it a document just stays undated, as before.
async function fillMissingPeriods(documents) {
  if (!Array.isArray(documents)) return documents;
  const undated = documents.filter((d) => d?.document_id && !(dmyToIso(d.start_date) && dmyToIso(d.end_date)));
  if (!undated.length) return documents;
  try {
    const { rows } = await pool.query(
      `SELECT document_id, to_char(MIN(transaction_date), 'YYYY-MM-DD') AS first_day,
              to_char(MAX(transaction_date), 'YYYY-MM-DD') AS last_day
       FROM ${DB_SCHEMA}.ocr_extractions
       WHERE document_id = ANY($1::text[]) AND transaction_date IS NOT NULL
       GROUP BY document_id`,
      [undated.map((d) => String(d.document_id))]
    );
    const byId = new Map(rows.map((r) => [r.document_id, r]));
    return documents.map((d) => {
      const found = byId.get(String(d?.document_id));
      return found && !(dmyToIso(d.start_date) && dmyToIso(d.end_date))
        ? { ...d, start_date: isoToDmy(found.first_day), end_date: isoToDmy(found.last_day) }
        : d;
    });
  } catch (err) {
    console.error("Could not fill statement periods:", err.message);
    return documents;
  }
}

// Keeps documents that overlap the window. One that still has no dates (nothing extracted yet) stays visible:
// hiding it would make a statement the user just uploaded disappear.
function filterDocuments(documents, window) {
  if (!Array.isArray(documents)) return documents;
  return documents.filter((doc) => {
    const start = dmyToIso(doc?.start_date);
    const end = dmyToIso(doc?.end_date);
    return !start || !end || overlapsWindow(start, end, window);
  });
}

export default function pdfServiceProxy(req, res) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!STRIP_REQUEST_HEADERS.has(name)) headers[name] = value;
  }
  headers.host = target.host;

  const filtered = documentList(req);
  // The answer is read and rewritten here, so ask the service for it uncompressed.
  if (filtered) delete headers["accept-encoding"];

  const upstream = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      // req.url is relative to the mount point, e.g. "/banks" or
      // "/documents?company_id=12"
      path: `${target.pathname.replace(/\/$/, "")}${filtered ? filtered.upstreamPath : req.url}`,
      headers,
    },
    (upRes) => {
      for (const [name, value] of Object.entries(upRes.headers)) {
        if (!STRIP_RESPONSE_HEADERS.has(name)) res.setHeader(name, value);
      }
      if (filtered && upRes.statusCode === 200) {
        const chunks = [];
        upRes.on("data", (chunk) => chunks.push(chunk));
        upRes.on("end", async () => {
          const raw = Buffer.concat(chunks);
          try {
            let documents = await fillMissingPeriods(JSON.parse(raw.toString("utf8")));
            if (filtered.window) documents = filterDocuments(documents, filtered.window);
            res.removeHeader("content-length");
            res.status(200).type("application/json").send(JSON.stringify(documents));
          } catch {
            // Not the JSON list we expected: pass it through as it came.
            res.status(200).send(raw);
          }
        });
        upRes.on("error", () => res.destroy());
        return;
      }
      res.status(upRes.statusCode || 502);
      upRes.pipe(res);
    }
  );

  // Only the connect phase is bounded — extraction/upload responses can
  // legitimately take a long time once the connection is up.
  const connectTimer = setTimeout(() => {
    upstream.destroy(new Error("connect timeout"));
  }, 10_000);
  upstream.on("socket", (socket) => {
    // A reused keep-alive socket is already connected and never emits
    // "connect" again.
    if (!socket.connecting) clearTimeout(connectTimer);
    else socket.once("connect", () => clearTimeout(connectTimer));
  });

  upstream.on("error", (err) => {
    clearTimeout(connectTimer);
    console.error(`PDF service proxy ${req.method} ${req.url} failed:`, err.message);
    if (!res.headersSent) {
      res.status(502).json({
        status: "error",
        message: "Bank statement service is unreachable",
      });
    } else {
      res.destroy(err);
    }
  });

  // Browser gave up / navigated away — don't leave the upstream call hanging.
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });

  req.pipe(upstream);
}
