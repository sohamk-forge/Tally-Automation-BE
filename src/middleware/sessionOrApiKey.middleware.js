import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { verifyConnectorApiKey } from "./apiKey.middleware.js";

const optionalSession = verifySession({ sessionRequired: false });

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
