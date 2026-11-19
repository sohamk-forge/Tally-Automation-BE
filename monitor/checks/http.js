import { config } from "../config.js";

export async function checkHttp() {
  return Promise.all(config.http.map(async (t) => {
    const name = `http:${t.name}`;
    const t0 = Date.now();
    try {
      const res = await fetch(t.url, { signal: AbortSignal.timeout(8000), redirect: "manual" });
      const ms = Date.now() - t0;
      if (!t.okCodes.includes(res.status) && !(res.status >= 300 && res.status < 400 && t.okCodes.includes(200)))
        return { name, status: t.optional ? "WARN" : "FAIL", detail: `HTTP ${res.status} ${t.url} (${ms}ms)` };
      return { name, status: ms > config.httpSlowMs ? "WARN" : "OK", detail: `HTTP ${res.status} ${ms}ms` };
    } catch (e) {
      return { name, status: t.optional ? "WARN" : "FAIL", detail: `unreachable ${t.url}: ${e.cause?.code || e.message}` };
    }
  }));
}
