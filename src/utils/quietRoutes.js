// Routes polled on a tight interval by every connected connector device —
// /api/connector/jobs every few seconds, /api/connector/heartbeat every 30s.
// Logging full request/response detail (and writing an audit_logs row) for
// every single poll, from every device, drowns out everything else in the
// terminal and grows audit_logs for no real signal. These stay quiet on the
// routine case; the endpoints themselves still log when something actually
// happens (e.g. a job is claimed).
const QUIET_ROUTE_PATTERNS = [
  /^\/api\/connector\/jobs(\?|$)/,
  /^\/api\/connector\/heartbeat(\?|$)/
];

export function isQuietRoute(req) {
  const path = req.originalUrl || req.url || "";
  return QUIET_ROUTE_PATTERNS.some((pattern) => pattern.test(path));
}
