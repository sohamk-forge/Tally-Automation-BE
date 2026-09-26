import express from "express";
import Passwordless from "supertokens-node/recipe/passwordless/index.js";
import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";
import { createInvite, listInvitesForUser, approveInvite, revokeInvite, getPendingInviteForUser, VALID_ROLES, InviteValidationError } from "../services/invite.service.js";
import { sendInviteEmail } from "../services/mailer.service.js";

const router = express.Router();

/* =========================================
   SEND INVITE
   Creates the SuperTokens user (if new) and emails a magic-link login.
   Falls back to logging the link if SMTP isn't configured.
========================================= */
router.post("/", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());
    if (!userId) {
      return res.status(404).json({ status: "error", message: "No profile found for this account" });
    }

    const { email, role = "staff" } = req.body;
    if (!email) {
      return res.status(400).json({ status: "error", message: "email is required" });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ status: "error", message: `role must be one of: ${VALID_ROLES.join(", ")}` });
    }

    // Validate (and insert the invites row) before touching SuperTokens —
    // no point minting a passwordless code/link for an invite that's about
    // to be rejected (self-invite, or an email that already has access).
    const invite = await createInvite(userId, email, role);

    await Passwordless.signInUp({ tenantId: "public", email });
    const inviteLink = await Passwordless.createMagicLink({ tenantId: "public", email });

    await sendInviteEmail(email, inviteLink);

    return res.status(201).json({
      status: "success",
      message: "Invite created",
      data: { ...invite, inviteLink },
    });
  } catch (err) {
    if (err instanceof InviteValidationError) {
      return res.status(400).json({ status: "error", message: err.message });
    }
    console.log("INVITE CREATE ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* =========================================
   LIST INVITES SENT BY CURRENT USER
========================================= */
router.get("/", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());
    if (!userId) {
      return res.status(404).json({ status: "error", message: "No profile found for this account" });
    }

    const invites = await listInvitesForUser(userId);

    return res.json({ status: "success", data: invites });
  } catch (err) {
    console.log("INVITE LIST ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* =========================================
   MY PENDING INVITE
   Used by the frontend to show a "waiting for approval" screen instead of
   the dashboard shell — any authenticated user can check their own status.
========================================= */
router.get("/my-pending", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());
    if (!userId) {
      return res.status(404).json({ status: "error", message: "No profile found for this account" });
    }

    const pending = await getPendingInviteForUser(userId);

    return res.json({ status: "success", data: pending });
  } catch (err) {
    console.log("INVITE MY-PENDING ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* =========================================
   APPROVE INVITE
   Grants the invitee access to every company the inviter currently has.
========================================= */
router.post("/:id/approve", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());
    if (!userId) {
      return res.status(404).json({ status: "error", message: "No profile found for this account" });
    }

    const result = await approveInvite(req.params.id, userId);

    if (result.error === "not_found") {
      return res.status(404).json({ status: "error", message: "Invite not found" });
    }
    if (result.error === "forbidden") {
      return res.status(403).json({ status: "error", message: "Only the inviter can approve this invite" });
    }
    if (result.error === "invalid_status") {
      return res.status(409).json({ status: "error", message: "Invite is not awaiting approval" });
    }
    if (result.error === "invitee_not_signed_in") {
      return res.status(409).json({ status: "error", message: "Invitee has not logged in via the invite link yet" });
    }
    if (result.error === "seat_taken") {
      return res.status(409).json({
        status: "error",
        message: `The ${result.role} seat for this company is already taken by ${result.takenBy}`
      });
    }
    if (result.error === "staff_limit_reached") {
      return res.status(409).json({
        status: "error",
        message: "This company already has the maximum number of staff members"
      });
    }

    return res.json({
      status: "success",
      message: "Invite approved",
      companiesGranted: result.companiesGranted,
    });
  } catch (err) {
    console.log("INVITE APPROVE ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* =========================================
   REVOKE INVITE
   Cancels a pending invite, or strips a previously-approved invitee's
   access (deletes exactly the connector_pairing_tokens rows that invite
   granted — nothing the invitee has independent of it).
========================================= */
router.post("/:id/revoke", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());
    if (!userId) {
      return res.status(404).json({ status: "error", message: "No profile found for this account" });
    }

    const result = await revokeInvite(req.params.id, userId);

    if (result.error === "not_found") {
      return res.status(404).json({ status: "error", message: "Invite not found" });
    }
    if (result.error === "forbidden") {
      return res.status(403).json({ status: "error", message: "Only the inviter can revoke this invite" });
    }
    if (result.error === "invalid_status") {
      return res.status(409).json({ status: "error", message: "Invite is already revoked" });
    }

    return res.json({
      status: "success",
      message: "Invite revoked",
      companiesRevoked: result.companiesRevoked,
    });
  } catch (err) {
    console.log("INVITE REVOKE ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

export default router;
