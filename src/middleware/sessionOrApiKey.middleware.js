import Session from "supertokens-node/recipe/session/index.js";
import { verifyConnectorApiKey } from "./apiKey.middleware.js";

// Deliberately NOT using verifySession({ sessionRequired: false }) from
// supertokens-node/recipe/session/framework/express here: that framework
// wrapper double-wraps the request object internally (ExpressRequest
// wrapping an already-wrapped request), which corrupts header/session
// detection specifically on this optional-session path and makes it throw
// "unauthorised" even when sessionRequired is false and no session-related
// headers are present at all — verified by calling the imperative
// Session.getSession() API directly with the exact same request, which
// correctly returns undefined with no throw. Calling the imperative API
// ourselves avoids the double-wrap entirely.
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
