import express from "express";
import crypto from "crypto";
import pool from "../db/index.js";
import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";

const router = express.Router();

/* =========================================
   GENERATE CONNECTOR KEY
   Initiated by a logged-in dashboard user, so this requires a real
   SuperTokens session — user_id is derived from it, not the request body.
========================================= */

router.post("/generate-key", verifySession(), async (req, res) => {
  try {

    const user_id = await getLocalUserId(req.session.getUserId());

    if (!user_id) {
      return res.status(404).json({
        status: "error",
        message: "No profile found for this account"
      });
    }

    const token =
      "PAIR-" +
      crypto.randomBytes(4).toString("hex").toUpperCase();

    const expiresAt = new Date(
      Date.now() + 10 * 60 * 1000
    );

    await pool.query(
      `
      INSERT INTO app_test.connector_pairing_tokens
      (
        id,
        user_id,
        token,
        expires_at
      )
      VALUES
      (
        gen_random_uuid(),
        $1,
        $2,
        $3
      )
      `,
      [
        user_id,
        token,
        expiresAt
      ]
    );

    return res.status(200).json({
      status: "success",
      token,
      expires_at: expiresAt
    });

  } catch (err) {

    console.error("Generate Key Error:", err);

    return res.status(500).json({
      status: "error",
      message: err.message
    });

  }
});


router.get("/current", verifySession(), async (req, res) => {
  try {
    const user_id = await getLocalUserId(req.session.getUserId());

    if (!user_id) {
      return res.status(404).json({
        status: "error",
        message: "No profile found for this account"
      });
    }

  const result = await pool.query(
`
SELECT
    company_name,
    from_year,
    to_year,
    tally_connected
FROM app_test.connector_machines
WHERE user_id = $1
  AND tally_connected = true
ORDER BY updated_at DESC
LIMIT 1
`,
[user_id]
);

    if (result.rows.length === 0) {
      return res.json({
        status: "success",
        paired: false,
        data: null
      });
    }

    return res.json({
      status: "success",
      paired: true,
      data: result.rows[0]
    });

  } catch (err) {
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;