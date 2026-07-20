import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { verifyConnectorApiKey } from "./apiKey.middleware.js";

const optionalSession = verifySession({ sessionRequired: false });

const fallbackToApiKey = (req, res, next) => {
  if (req.session) {
    return next();
  }
  return verifyConnectorApiKey(req, res, next);
};

/**
 * Accepts either a browser SuperTokens session (dashboard) or a connector
 * API key (desktop Tally connector) — these routes are called by both.
 */
export const requireSessionOrApiKey = () => [optionalSession, fallbackToApiKey];
