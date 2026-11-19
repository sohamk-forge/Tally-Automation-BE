import { execFile } from "child_process";
import { promisify } from "util";
const sh = promisify(execFile);
const lastRestarts = {};

export async function checkPm2() {
  try {
    const list = JSON.parse((await sh("pm2", ["jlist"], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 })).stdout.replace(/^[^\[]*/, ""));
    if (!list.length) return [{ name: "pm2", status: "OK", detail: "no pm2 processes (dev mode)" }];
    return list.map((p) => {
      const r = p.pm2_env.restart_time, prev = lastRestarts[p.name];
      lastRestarts[p.name] = r;
      const online = p.pm2_env.status === "online";
      const looping = prev !== undefined && r - prev >= 3;
      return { name: `pm2:${p.name}`, status: !online ? "FAIL" : looping ? "WARN" : "OK",
        detail: `${p.pm2_env.status}, restarts ${r}${looping ? ` (+${r - prev} since last check)` : ""}, ${(p.monit.memory / 1048576).toFixed(0)}MB, cpu ${p.monit.cpu}%` };
    });
  } catch { return []; }
}
