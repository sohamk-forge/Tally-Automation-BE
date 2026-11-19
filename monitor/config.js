import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const n = (v, d) => (v === undefined || v === "" || isNaN(Number(v)) ? d : Number(v));

export const config = {
  logDir: path.join(here, "logs"),
  keepDays: n(process.env.MONITOR_KEEP_DAYS, 14),
  alertTo: process.env.MONITOR_ALERT_TO || process.env.SMTP_USER,
  reminderMs: n(process.env.MONITOR_REMINDER_HOURS, 6) * 3600_000,
  // consecutive failing cycles before a FAIL is alerted (avoids blip emails)
  failAfter: n(process.env.MONITOR_FAIL_AFTER, 2),

  intervals: {
    fast: n(process.env.MONITOR_FAST_SEC, 30) * 1000,   // host, redis, queues, http
    slow: n(process.env.MONITOR_SLOW_SEC, 120) * 1000,  // postgres, pipeline, logs
  },

  http: [
    { name: "backend", url: `http://127.0.0.1:${process.env.PORT || 5001}/api/v1/voucher`, okCodes: [200, 401, 403, 404] },
    { name: "frontend", url: "http://127.0.0.1:5173/", okCodes: [200] },
    { name: "banking-endpoint", url: `http://127.0.0.1:${process.env.PORT || 5001}/api/banks`, okCodes: [200, 401, 403] },
    { name: "purchase-endpoint", url: `http://127.0.0.1:${process.env.PORT || 5001}/api/v1/purchase`, okCodes: [200, 401, 403, 404] },
    { name: "purchase-validation-endpoint", url: `http://127.0.0.1:${process.env.PORT || 5001}/api/purchase-validation`, okCodes: [200, 401, 403, 404] },
    { name: "supertokens", url: (process.env.SUPERTOKENS_CONNECTION_URI || "http://127.0.0.1:3567") + "/hello", okCodes: [200] },
    { name: "ollama", url: "http://127.0.0.1:11434/api/tags", okCodes: [200] },
    { name: "ocr-service", url: process.env.PROXY_OCR_TARGET || "http://192.168.0.14:3000", okCodes: [200, 301, 302, 401, 403, 404], optional: true },
    { name: "pdf-service", url: process.env.PDF_SERVICE_URL || "http://192.168.0.14:9001", okCodes: [200, 301, 302, 401, 403, 404], optional: true },
  ],
  httpSlowMs: n(process.env.MONITOR_HTTP_SLOW_MS, 3000),

  queues: [
    "bulk-purchase", "bank-push", "purchase-invoice-queue", "sales-invoice-queue", "invoice-queue",
    "ledger-push", "sync-queue", "od-bank-push", "stock-item-push", "xml-generation", "pushVoucher",
  ],
  queueWaitingMaxMin: n(process.env.MONITOR_QUEUE_WAIT_MIN, 10),

  redis: { memWarnPct: 80, hitRatioWarn: 0.5, hitRatioMinOps: 1000 },
  host: { cpuWarn: 90, ramWarn: 90, swapWarn: 50, diskWarn: 85, tempWarn: 85, gpuTempWarn: 85, gpuMemWarn: 95 },
  ports: [5001, 5173, 6379, 11434],
  pg: { connWarnPct: 80, longQuerySec: 300, idleTxSec: 300 },
  pipeline: {
    pendingMin: 5, claimedMin: 15, connectorOfflineMin: 15,
    waitingLedgerWarn: 50, ledgerMissingWarn: 1, failedRecentHours: 1, failedRecentWarn: 20,
  },
  logs: {
    errorSpikePerCycle: 25,
    pm2Dir: process.env.PM2_HOME ? path.join(process.env.PM2_HOME, "logs") : path.join(process.env.HOME || "", ".pm2", "logs"),
    files: [
      { source: "redis", file: "/var/log/redis/redis-server.log" },
    ],
    journalUnits: ["ollama", "redis-server", "ssh"],
    docker: ["supertokens"],
  },
};
