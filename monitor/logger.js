import fs from "fs";
import path from "path";
import { config } from "./config.js";

fs.mkdirSync(config.logDir, { recursive: true });
const day = () => new Date().toISOString().slice(0, 10);

export function logEvent(level, component, msg, extra = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, component, msg, ...extra });
  try { fs.appendFileSync(path.join(config.logDir, `monitor-${day()}.log`), line + "\n"); } catch {}
  if (process.env.MONITOR_QUIET !== "1") console.log(line);
}

export function rotate() {
  const cutoff = Date.now() - config.keepDays * 86400_000;
  for (const f of fs.readdirSync(config.logDir)) {
    if (!/^monitor-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
    const p = path.join(config.logDir, f);
    if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
  }
}

export function writeStatus(results) {
  const order = { FAIL: 0, WARN: 1, OK: 2 };
  const rows = [...results].sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  const counts = rows.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  const text =
    `Tally monitor status @ ${new Date().toISOString()}\n` +
    `OK=${counts.OK || 0} WARN=${counts.WARN || 0} FAIL=${counts.FAIL || 0}\n\n` +
    rows.map((r) => `${r.status.padEnd(4)} ${r.name.padEnd(34)} ${r.detail}`).join("\n") + "\n";
  fs.writeFileSync(path.join(config.logDir, "status.txt"), text);
  return text;
}
