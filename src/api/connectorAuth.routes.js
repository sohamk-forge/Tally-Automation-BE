import express from "express";
import pool from "../db/index.js";

const router = express.Router();

router.post("/pair", async (req, res) => {

  try {

    const {
      token,
      machine_id
    } = req.body;

    if (!token) {
      return res.status(400).json({
        status: "error",
        message: "token is required"
      });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM app_test.connector_pairing_tokens
      WHERE token = $1
      LIMIT 1
      `,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Invalid token"
      });
    }

   const pairingToken = result.rows[0];

if (pairingToken.is_used) {
  return res.status(400).json({
    status: "error",
    message: "Token already used"
  });
}

if (new Date(pairingToken.expires_at) < new Date()) {
  return res.status(400).json({
    status: "error",
    message: "Token expired"
  });
}

return res.status(200).json({
  status: "success",
  message: "Token is valid",
  data: {
    user_id: pairingToken.user_id,
    token: pairingToken.token
  }
});

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      status: "error",
      message: err.message
    });

  }

});

export default router;