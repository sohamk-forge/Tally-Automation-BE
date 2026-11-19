import { Queue } from "bullmq";
import { config } from "../config.js";
import { redisConn } from "./redis.js";

const queues = {};
const lastFailed = {};

export async function checkQueues() {
  const out = [];
  const conn = redisConn();
  for (const qn of config.queues) {
    const name = `queue:${qn}`;
    try {
      const q = (queues[qn] ||= new Queue(qn, { connection: conn }));
      const c = await q.getJobCounts("waiting", "active", "delayed", "failed", "paused");
      const [oldest] = await q.getWaiting(0, 0);
      const ageMin = oldest ? (Date.now() - oldest.timestamp) / 60000 : 0;
      const workers = (await q.getWorkers().catch(() => [])).length;
      const before = lastFailed[qn];
      const grew = before !== undefined && c.failed > before;
      lastFailed[qn] = c.failed;
      let status = "OK", why = [];
      if (grew) { status = "WARN"; why.push(`failed +${c.failed - before}`); }
      if (ageMin > config.queueWaitingMaxMin) { status = "WARN"; why.push(`oldest waiting ${ageMin.toFixed(0)}m`); }
      if (c.waiting > 0 && workers === 0) { status = "WARN"; why.push("jobs waiting but no worker connected"); }
      if (grew) {
        const fj = await q.getFailed(0, 0);
        if (fj[0]) why.push(`latest: ${String(fj[0].failedReason).slice(0, 120)}`);
      }
      out.push({ name, status, detail: `wait ${c.waiting} active ${c.active} delayed ${c.delayed} failed ${c.failed} workers ${workers}${why.length ? " | " + why.join("; ") : ""}` });
    } catch (e) {
      out.push({ name, status: "FAIL", detail: `cannot read queue: ${e.message}` });
    }
  }
  return out;
}
