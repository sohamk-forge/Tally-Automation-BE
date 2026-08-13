import { getLocalUserId } from "./getLocalUserId.js";

/**
 * Resolves the local numeric user id from whichever auth method
 * requireSessionOrApiKey() actually authenticated the request with.
 *
 * - Session auth: req.session.getUserId() is the SuperTokens UUID, which
 *   still needs mapping to the local users.id via getLocalUserId().
 * - API-key auth: verifyConnectorApiKey() already resolves and attaches the
 *   local numeric id directly as req.connectorMachine.userId — no further
 *   lookup needed (and calling getLocalUserId on it would be wrong, since
 *   it's not a SuperTokens UUID).
 *
 * Returns null if authenticated but no local profile is linked, or if
 * neither auth method actually populated the request (shouldn't happen
 * behind requireSessionOrApiKey(), but callers should still check).
 */
export async function resolveUserId(req) {
  if (req.session) {
    return await getLocalUserId(req.session.getUserId());
  }

  if (req.connectorMachine) {
    return req.connectorMachine.userId;
  }

  if (req.internalUserId) {
    return req.internalUserId;
  }

  return null;
}