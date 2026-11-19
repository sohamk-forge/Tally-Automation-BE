import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { config } from "../config.js";
import { logEvent } from "../logger.js";

const sh = promisify(execFile);
const offsets = {};
const seen = new Set();
let lastRun = Date.now();
let firstRun = true;
export const newSignatures = []; // drained by monitor.js for alert emails

const ERR = /\b(error|fatal|exception|unhandled|ECONN\w+|ETIMEDOUT|ENOTFOUND|OOM|out of memory|failed|panic|segfault|killed process)\b/i;
const WARN = /\b(warn|warning|deprecated)\b/i;
const mask = (s) => s
  .replace(/(password|passwd|pwd|token|secret|api[_-]?key|authorization|bearer)(["'\s:=]+)([^\s"',;]+)/gi, "$1$2***")
  .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
  .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<jwt>");
const signature = (s) => s.replace(/\d{4}-\d\d-\d\d[T ][\d:.,Z+-]+/g, "").replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<id>").replace(/\b\d+\b/g, "N").replace(/\s+/g, " ").trim().slice(0, 140);

function ingest(source, lines) {
  let errors = 0;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const level = ERR.test(raw) ? "error" : WARN.test(raw) ? "warn" : null;
    if (!level) continue;
    const msg = mask(raw).slice(0, 400);
    if (level === "error") {
      errors++;
      const sig = `${source}|${signature(msg)}`;
      if (!seen.has(sig)) {
        seen.add(sig);
        if (!firstRun) newSignatures.push({ source, msg });
        logEvent("error", `log:${source}`, msg, { newSignature: !firstRun });
      }
    } else logEvent("warn", `log:${source}`, msg);
  }
  return errors;
}

function tailFile(source, file) {
  try {
    const st = fs.statSync(file);
    let off = offsets[file];
    if (off === undefined || st.size < off) off = firstRun ? Math.max(0, st.size - 64 * 1024) : 0; // seed: last 64KB
    if (st.size === off) return 0;
    const fd = fs.openSync(file, "r");
    const len = Math.min(st.size - off, 2 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, off);
    fs.closeSync(fd);
    offsets[file] = off + len;
    return ingest(source, buf.toString("utf8").split("\n"));
  } catch { return 0; }
}

export async function checkLogs() {
  const out = [];
  const since = Math.max(1, Math.ceil((Date.now() - lastRun) / 1000) + 5);
  lastRun = Date.now();
  const counts = {};
  const add = (src, n) => (counts[src] = (counts[src] || 0) + n);

  for (const f of config.logs.files) add(f.source, tailFile(f.source, f.file));
  try {
    for (const f of fs.readdirSync(config.logs.pm2Dir).filter((f) => /-error\.log$/.test(f)))
      add(f.replace(/-error\.log$/, ""), tailFile(f.replace(/-error\.log$/, ""), path.join(config.logs.pm2Dir, f)));
  } catch {}
  for (const u of config.logs.journalUnits) {
    try {
      const { stdout } = await sh("journalctl", ["-u", u, "--since", `${firstRun ? 600 : since} seconds ago`, "-p", "warning", "--no-pager", "-o", "cat"], { timeout: 8000 });
      add(u, ingest(u, stdout.split("\n")));
    } catch {}
  }
  try {
    const { stdout } = await sh("journalctl", ["-k", "--since", `${firstRun ? 600 : since} seconds ago`, "--no-pager", "-o", "cat"], { timeout: 8000 });
    const k = stdout.split("\n").filter((l) => /out of memory|oom-kill|killed process|nvrm|xid|i\/o error|segfault/i.test(l));
    add("kernel", ingest("kernel", k));
  } catch {}
  for (const c of config.logs.docker) {
    try {
      const { stdout, stderr } = await sh("docker", ["logs", "--since", `${firstRun ? 600 : since}s`, c], { timeout: 8000 });
      add(`docker:${c}`, ingest(`docker:${c}`, (stdout + "\n" + stderr).split("\n")));
    } catch {}
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const detail = Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(", ");
  out.push({ name: "logs:errors", status: total >= config.logs.errorSpikePerCycle ? "WARN" : "OK",
    detail: total ? `${total} error line(s) this cycle (${detail})` : "no new errors in watched logs" });
  firstRun = false;
  return out;
}
