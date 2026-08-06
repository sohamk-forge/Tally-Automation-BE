import Session from "supertokens-node/recipe/session/index.js";
import { verifyConnectorApiKey } from "./apiKey.middleware.js";

// Deliberately not using verifySession({ sessionRequired: false }) from the
// framework/express wrapper here: it double-wraps the request object
// internally, which corrupts header/session detection on this specific
// optional-session path and throws "unauthorised" even when no session
// data is present at all. Calling the imperative Session.getSession() API
// directly avoids the double-wrap and behaves correctly.
const optionalSession = async (req, res, next) => {
  try {
    req.session = await Session.getSession(req, res, { sessionRequired: false });
  } catch (err) {
    // Any error here just means "no valid session" for our purposes —
    // fall through to the API-key check rather than failing the request.
  }
  next();
};

const fallbackToApiKey = (req, res, next) => {
  if (req.session) {
    return next();
  }

  // Same-process internal calls (e.g. sync.worker.js hitting its own
  // /api/sync/* routes over HTTP) — not a browser or the desktop connector,
  // so neither a session nor a connector API key applies here.
  const internalSecret = req.headers["x-internal-secret"];
  if (
    internalSecret &&
    process.env.INTERNAL_SERVICE_SECRET &&
    internalSecret === process.env.INTERNAL_SERVICE_SECRET
  ) {
    return next();
  }

  return verifyConnectorApiKey(req, res, next);
};

/**
 * Accepts either a browser SuperTokens session (dashboard) or a connector
 * API key (desktop Tally connector) — these routes are called by both.
 */
export const requireSessionOrApiKey = () => [optionalSession, fallbackToApiKey];
