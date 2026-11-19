import { execFile } from "child_process";
import { promisify } from "util";
import { config } from "../config.js";
const sh = promisify(execFile);

export async function checkGpu() {
  try {
    const { stdout } = await sh("nvidia-smi", ["--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw", "--format=csv,noheader,nounits"], { timeout: 8000 });
    return stdout.trim().split("\n").map((l, i) => {
      const [name, util, used, total, temp, power] = l.split(",").map((s) => s.trim());
      const memPct = (used / total) * 100;
      return { name: `gpu:${i}`, status: temp > config.host.gpuTempWarn || memPct > config.host.gpuMemWarn ? "WARN" : "OK",
        detail: `${name}: util ${util}%, VRAM ${used}/${total}MiB (${memPct.toFixed(0)}%), ${temp}°C, ${power}W` };
    });
  } catch (e) {
    return e.code === "ENOENT" ? [] : [{ name: "gpu:0", status: "WARN", detail: `nvidia-smi failed: ${String(e.message).split("\n")[0]}` }];
  }
}
