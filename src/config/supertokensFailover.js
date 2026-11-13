import "dotenv/config";

/*
 * Priority-ordered SuperTokens core failover.
 *
 * Hosts, in order:
 *   SUPERTOKENS_CONNECTION_URI  ';'-separated list (SDK format)
 *   SUPERTOKENS_FALLBACK_URI    final core, tried only after every list entry
 *
 * Why not just hand the ';' list to the SDK: supertokens-node round-robins
 * EVERY request across all hosts (querier.js lastTriedIndex++), so the
 * fallback would get traffic even while the primary is healthy, and it only
 * skips a host on ECONNREFUSED (a black-holed IP hangs). Instead the SDK is
 * given only the first host, and networkInterceptor rewrites each core call
 * to whichever host the health monitor currently marks active.
 */

const normalize = (uri) => uri.trim().replace(/\/+$/, "");

export function parseSupertokensHosts(env = process.env) {
  const list = (env.SUPERTOKENS_CONNECTION_URI || "")
    .split(";")
    .map(normalize)
    .filter(Boolean);
  const fallback = env.SUPERTOKENS_FALLBACK_URI ? normalize(env.SUPERTOKENS_FALLBACK_URI) : "";

  const seen = new Set();
  const hosts = [];
  const push = (uri, label) => {
    if (!uri || seen.has(uri)) return;
    seen.add(uri);
    hosts.push({ uri, label });
  };
  list.forEach((uri, i) => push(uri, i === 0 ? "primary" : `env#${i + 1}`));
  push(fallback, "fallback");
  return hosts;
}

const hosts = parseSupertokensHosts();
const state = hosts.map(() => ({ healthy: null, lastCheckedAt: null, lastError: null }));
let activeIndex = 0;
let probeInFlight = null;
let lastProbeAt = 0;
let monitorTimer = null;

const PROBE_TIMEOUT_MS = Number(process.env.SUPERTOKENS_PROBE_TIMEOUT_MS) || 3000;
const PROBE_INTERVAL_MS = Number(process.env.SUPERTOKENS_PROBE_INTERVAL_MS) || 10000;

const describe = (i) => `${hosts[i].label} (${hosts[i].uri})`;

/** The URI to give supertokens.init — the interceptor rewrites from it. */
export function getPlaceholderConnectionURI() {
  return hosts[0]?.uri;
}

async function probe(i) {
  try {
    const res = await fetch(`${hosts[i].uri}/hello`, {
      headers: process.env.SUPERTOKENS_API_KEY ? { "api-key": process.env.SUPERTOKENS_API_KEY } : {},
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    Object.assign(state[i], {
      healthy: res.ok,
      lastCheckedAt: new Date().toISOString(),
      lastError: res.ok ? null : `HTTP ${res.status}`,
    });
  } catch (err) {
    Object.assign(state[i], {
      healthy: false,
      lastCheckedAt: new Date().toISOString(),
      lastError: err.cause?.code || err.cause?.message || err.name || err.message,
    });
  }
}

/** Probe all cores in parallel and move to the first healthy one. Single-flight. */
export function probeNow() {
  if (!hosts.length) return Promise.resolve();
  if (!probeInFlight) {
    probeInFlight = (async () => {
      lastProbeAt = Date.now();
      await Promise.all(hosts.map((_, i) => probe(i)));
      const best = state.findIndex((s) => s.healthy);
      if (best === -1) {
        console.error(
          "[st-failover] all SuperTokens cores unreachable — " +
            hosts.map((_, i) => `${describe(i)}: ${state[i].lastError}`).join("; ")
        );
        return;
      }
      if (best !== activeIndex) {
        console.warn(`[st-failover] ${describe(activeIndex)} -> ${describe(best)}`);
        activeIndex = best;
      }
    })().finally(() => {
      probeInFlight = null;
    });
  }
  return probeInFlight;
}

/** Called when a request fails with a core connectivity error. Rate-limited. */
export function triggerProbe() {
  if (Date.now() - lastProbeAt < 2000) return;
  probeNow().catch(() => {});
}

export function isSupertokensConnectivityError(err) {
  const msg = String(err?.message || "");
  return (
    /No SuperTokens core available|fetch failed|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH/i.test(msg) ||
    ["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENOTFOUND"].includes(err?.code || err?.cause?.code)
  );
}

export function startSupertokensMonitor() {
  if (monitorTimer || hosts.length <= 1) return; // nothing to fail over to
  probeNow().catch(() => {});
  monitorTimer = setInterval(() => probeNow().catch(() => {}), PROBE_INTERVAL_MS);
  monitorTimer.unref?.();
}

/** supertokens.networkInterceptor — point the core call at the active host. */
export function networkInterceptor(request) {
  if (activeIndex === 0 || !hosts.length) return request;
  try {
    const from = new URL(hosts[0].uri);
    const to = new URL(hosts[activeIndex].uri);
    const url = new URL(request.url);
    if (url.origin !== from.origin) return request;

    const fromBase = from.pathname.replace(/\/+$/, "");
    const toBase = to.pathname.replace(/\/+$/, "");
    const rest = fromBase && url.pathname.startsWith(fromBase)
      ? url.pathname.slice(fromBase.length)
      : url.pathname;

    return { ...request, url: `${to.origin}${toBase}${rest}${url.search}` };
  } catch {
    return request;
  }
}

export function getSupertokensStatus() {
  return {
    active: hosts[activeIndex]?.label ?? null,
    hosts: hosts.map((h, i) => ({ label: h.label, ...state[i] })),
  };
}
