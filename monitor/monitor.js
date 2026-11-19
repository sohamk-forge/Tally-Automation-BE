import { config } from "./config.js";
import { logEvent, rotate, writeStatus } from "./logger.js";
import { sendAlert as mail } from "./alert.js";
const sendAlert = (...a) => (NO_MAIL ? Promise.resolve(false) : mail(...a));
import { checkHttp } from "./checks/http.js";
import { checkRedis } from "./checks/redis.js";
import { checkQueues } from "./checks/queues.js";
import { checkHost } from "./checks/host.js";
import { checkGpu } from "./checks/gpu.js";
import { checkPm2 } from "./checks/pm2.js";
import { checkPostgres } from "./checks/postgres.js";
import { checkPipeline } from "./checks/pipeline.js";
import { checkLogs, newSignatures } from "./checks/logs.js";

const ONCE = process.argv.includes("--once");
const NO_MAIL = ONCE && !process.argv.includes("--alert"); // manual snapshot never emails unless --alert
const FAST = [checkHttp, checkRedis, checkQueues, checkHost, checkGpu, checkPm2];
const SLOW = [checkPostgres, checkPipeline, checkLogs];

const latest = new Map();   // name -> result
const state = new Map();    // name -> { status, since, badCycles, lastAlert, alerted }

async function runGroup(fns) {
  const settled = await Promise.all(fns.map((f) =>
    f().catch((e) => [{ name: `monitor:${f.name}`, status: "FAIL", detail: `check crashed: ${e.message}` }])));
  const results = settled.flat();
  const now = Date.now();
  const toAlert = [], recovered = [], pendingMark = [];
  for (const r of results) {
    latest.set(r.name, r);
    let s = state.get(r.name) || { status: "OK", since: now, badCycles: 0, alerted: false, lastAlert: 0 };
    if (r.status !== s.status) {
      logEvent(r.status === "OK" ? "info" : r.status === "WARN" ? "warn" : "error", r.name, `${s.status} -> ${r.status}: ${r.detail}`);
      s = { ...s, status: r.status, since: now, badCycles: 0 };
    }
    if (r.status === "OK") {
      if (s.alerted) recovered.push({ ...r, downFor: Math.round((now - s.since) / 60000) });
      s.alerted = false; s.badCycles = 0;
    } else {
      s.badCycles++;
      const threshold = r.status === "FAIL" ? config.failAfter : 1;
      if (s.badCycles >= threshold && (!s.alerted || now - s.lastAlert > config.reminderMs)) {
        toAlert.push({ ...r, reminder: s.alerted });
        pendingMark.push(s);
        s.lastAlert = now;
      }
    }
    state.set(r.name, s);
  }
  if (toAlert.length) {
    const fails = toAlert.filter((a) => a.status === "FAIL").length;
    const ok = await sendAlert(`${fails ? "FAIL" : "WARN"}: ${toAlert.map((a) => a.name).join(", ").slice(0, 120)}`,
      [...toAlert.map((a) => `${a.status} ${a.name}${a.reminder ? " (still failing)" : ""}\n   ${a.detail}`), "", "Full snapshot: Tally-Automation-BE/monitor/logs/status.txt"]);
    for (const s of pendingMark) { if (ok || NO_MAIL) s.alerted = true; else s.lastAlert = 0; } // retry next cycle if mail failed
  }
  if (recovered.length)
    await sendAlert(`RECOVERED: ${recovered.map((a) => a.name).join(", ").slice(0, 120)}`,
      recovered.map((a) => `OK ${a.name} (was bad ~${a.downFor} min)\n   ${a.detail}`));
  if (newSignatures.length) {
    const batch = newSignatures.splice(0).slice(0, 15);
    await sendAlert(`New error pattern(s) in logs (${batch.length})`, batch.map((b) => `[${b.source}] ${b.msg}`));
  }
  const text = writeStatus([...latest.values()]);
  return text;
}

logEvent("info", "monitor", `starting${ONCE ? " (once)" : ""}; alerts to ${config.alertTo || "NONE"}`);
if (ONCE) {
  process.env.MONITOR_QUIET = "1";
  await runGroup(FAST); await new Promise((r) => setTimeout(r, 1500));
  await runGroup(FAST); // second pass gives deltas (cpu, redis hit ratio)
  const text = await runGroup(SLOW);
  console.log(text);
  process.exit(0);
}
const loop = (fns, ms) => { const tick = async () => { try { await runGroup(fns); } catch (e) { logEvent("error", "monitor", e.message); } setTimeout(tick, ms); }; tick(); };
loop(FAST, config.intervals.fast);
loop(SLOW, config.intervals.slow);
setInterval(rotate, 6 * 3600_000); rotate();
process.on("SIGTERM", () => { logEvent("info", "monitor", "stopping"); process.exit(0); });
