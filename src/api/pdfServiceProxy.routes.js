import http from "node:http";
import https from "node:https";

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

export default function pdfServiceProxy(req, res) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!STRIP_REQUEST_HEADERS.has(name)) headers[name] = value;
  }
  headers.host = target.host;

  const upstream = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      // req.url is relative to the mount point, e.g. "/banks" or
      // "/documents?company_id=12"
      path: `${target.pathname.replace(/\/$/, "")}${req.url}`,
      headers,
    },
    (upRes) => {
      for (const [name, value] of Object.entries(upRes.headers)) {
        if (!STRIP_RESPONSE_HEADERS.has(name)) res.setHeader(name, value);
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
