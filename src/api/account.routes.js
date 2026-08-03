import express from "express";
import supertokens from "supertokens-node";
import { deleteUser } from "supertokens-node";
import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";
import { getHasPassword, setPasswordForUser } from "../services/account.service.js";

const router = express.Router();

/* =========================================
   ACCOUNT STATUS
   Frontend uses this to know whether to force the "set a password" screen
   (invited teammates first log in via a passwordless magic link, which has
   no password attached).
========================================= */
router.get("/status", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());
    if (!userId) {
      return res.status(404).json({ status: "error", message: "No profile found for this account" });
    }

    const hasPassword = await getHasPassword(userId);
    return res.json({ status: "success", data: { hasPassword } });
  } catch (err) {
    console.log("ACCOUNT STATUS ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* =========================================
   SET PASSWORD
   Converts the current passwordless-only login into a real EmailPassword
   one. Revokes the current (passwordless) session afterward — the user
   signs back in with their new password from the normal login form.
========================================= */
router.post("/set-password", verifySession(), async (req, res) => {
  try {
    const supertokensUserId = req.session.getUserId();
    const userId = await getLocalUserId(supertokensUserId);
    if (!userId) {
      return res.status(404).json({ status: "error", message: "No profile found for this account" });
    }

    const { password } = req.body;
    if (!password || password.length < 8) {
      return res.status(400).json({ status: "error", message: "Password must be at least 8 characters" });
    }

    const supertokensUser = await supertokens.getUser(supertokensUserId);
    const email = supertokensUser?.emails?.[0];
    if (!email) {
      return res.status(400).json({ status: "error", message: "Could not resolve account email" });
    }

    const result = await setPasswordForUser(userId, email, password);
    if (result.error) {
      return res.status(400).json({ status: "error", message: result.error });
    }

    await req.session.revokeSession();

    // The old passwordless-only identity is no longer needed once the user
    // has a real EmailPassword login — clean it up rather than leaving a
    // duplicate, unusable login method behind.
    const isPasswordlessOnly = supertokensUser.loginMethods.every((lm) => lm.recipeId === "passwordless");
    if (isPasswordlessOnly) {
      await deleteUser(supertokensUserId);
    }

    return res.json({ status: "success", message: "Password set. Please sign in again." });
  } catch (err) {
    console.log("SET PASSWORD ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

export default router;
