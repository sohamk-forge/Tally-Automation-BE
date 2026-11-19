import os from "os";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import net from "net";
import { config } from "../config.js";

const sh = promisify(execFile);
const H = config.host;
let prevCpu;

const cpuTimes = () => os.cpus().map((c) => c.times);
function cpuPct() {
  const now = cpuTimes();
  if (!prevCpu) { prevCpu = now; return null; }
  let idle = 0, total = 0;
  now.forEach((t, i) => {
    const p = prevCpu[i];
    const d = Object.keys(t).reduce((a, k) => a + (t[k] - p[k]), 0);
    total += d; idle += t.idle - p.idle;
  });
  prevCpu = now;
  return total ? (1 - idle / total) * 100 : 0;
}
const memInfo = () => Object.fromEntries(fs.readFileSync("/proc/meminfo", "utf8").split("\n").filter(Boolean).map((l) => { const [k, v] = l.split(":"); return [k, parseInt(v) * 1024]; }));
const port = (p) => new Promise((res) => { const s = net.connect({ port: p, host: "127.0.0.1", timeout: 1500 }); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); s.on("timeout", () => { s.destroy(); res(false); }); });

export async function checkHost() {
  const out = [];
  const cpu = cpuPct();
  const [l1, l5] = os.loadavg();
  const cores = os.cpus().length;
  let temp = null;
  try {
    for (const z of fs.readdirSync("/sys/class/thermal").filter((d) => d.startsWith("thermal_zone"))) {
      const t = parseInt(fs.readFileSync(`/sys/class/thermal/${z}/temp`, "utf8")) / 1000;
      if (temp === null || t > temp) temp = t;
    }
  } catch {}
  out.push({ name: "host:cpu", status: (cpu !== null && cpu > H.cpuWarn) || l5 > cores * 1.5 || (temp !== null && temp > H.tempWarn) ? "WARN" : "OK",
    detail: `${cpu === null ? "n/a" : cpu.toFixed(0) + "%"} of ${cores} cores, load ${l1.toFixed(2)}/${l5.toFixed(2)}${temp !== null ? `, ${temp.toFixed(0)}°C` : ""}` });

  const m = memInfo();
  const usedPct = ((m.MemTotal - m.MemAvailable) / m.MemTotal) * 100;
  const swapUsed = m.SwapTotal ? ((m.SwapTotal - m.SwapFree) / m.SwapTotal) * 100 : 0;
  const gb = (b) => (b / 1073741824).toFixed(1);
  let top = "";
  try { top = (await sh("ps", ["-eo", "comm,rss", "--sort=-rss", "--no-headers"])).stdout.trim().split("\n").slice(0, 3).map((l) => { const [c, r] = l.trim().split(/\s+/); return `${c} ${(r / 1024).toFixed(0)}MB`; }).join(", "); } catch {}
  out.push({ name: "host:ram", status: usedPct > H.ramWarn || swapUsed > H.swapWarn ? "WARN" : "OK",
    detail: `${gb(m.MemTotal - m.MemAvailable)}/${gb(m.MemTotal)}GB (${usedPct.toFixed(0)}%), swap ${swapUsed.toFixed(0)}% | top: ${top}` });

  try {
    const df = (await sh("df", ["-P", "-B1", "/", os.homedir()])).stdout.trim().split("\n").slice(1);
    const seen = new Set();
    for (const l of df) {
      const f = l.split(/\s+/); if (seen.has(f[5])) continue; seen.add(f[5]);
      const pct = parseInt(f[4]);
      out.push({ name: `host:disk:${f[5]}`, status: pct > H.diskWarn ? "WARN" : "OK", detail: `${pct}% used, ${gb(f[3])}GB free` });
    }
    const di = (await sh("df", ["-Pi", "/"])).stdout.trim().split("\n")[1].split(/\s+/);
    out.push({ name: "host:inodes", status: parseInt(di[4]) > 90 ? "WARN" : "OK", detail: `${di[4]} used` });
  } catch (e) { out.push({ name: "host:disk", status: "WARN", detail: e.message }); }

  const ports = await Promise.all(config.ports.map(async (p) => [p, await port(p)]));
  const down = ports.filter(([, ok]) => !ok).map(([p]) => p);
  out.push({ name: "host:ports", status: down.length ? "FAIL" : "OK", detail: down.length ? `not listening: ${down.join(", ")}` : `listening: ${config.ports.join(", ")}` });

  try {
    const ts = JSON.parse((await sh("tailscale", ["status", "--json"], { timeout: 5000 })).stdout);
    out.push({ name: "host:tailscale", status: ts.BackendState === "Running" ? "OK" : "WARN", detail: ts.BackendState });
  } catch { out.push({ name: "host:tailscale", status: "OK", detail: "not available (skipped)" }); }
  return out;
}
