import express from "express";
import pool from "../db/index.js";
import jwt from "jsonwebtoken";

const router = express.Router();

router.post("/pair", async (req, res) => {

  try {

    const {
  token,
  machine_id
} = req.body;

    // Validate token
    if (!token) {
      return res.status(400).json({
        status: "error",
        message: "token is required"
      });
    }

    // Validate machine_id
    if (!machine_id) {
      return res.status(400).json({
        status: "error",
        message: "machine_id is required"
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

    // Fetch user
    const userResult = await pool.query(
      `
      SELECT *
      FROM app_test.users
      WHERE id = $1
      LIMIT 1
      `,
      [pairingToken.user_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    const user = userResult.rows[0];

    // ✅ NEW: Lookup company_id from company_name
const companyId = pairingToken.company_id || null;
console.log(`✅ Company ID from token: ${companyId}`);

    // Generate JWT
    const jwtToken = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        machine_id
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "30d"
      }
    );

    // ✅ UPDATED: Mark token as used and save company_id
    const updateResult = await pool.query(
      `
      UPDATE app_test.connector_pairing_tokens
      SET
        is_used = TRUE,
        machine_id = $1,
        company_id = $2
      WHERE id = $3
      RETURNING id
      `,
      [
        machine_id,
        companyId,  // ✅ Save company_id!
        pairingToken.id
      ]
    );

    if (updateResult.rows.length === 0) {
      return res.status(500).json({
        status: "error",
        message: "Failed to update pairing token"
      });
    }

    // ✅ AUTO-INSERT user_companies when pairing!
if (companyId) {
  await pool.query(
    `INSERT INTO app_test.user_companies (user_id, company_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [user.id, companyId]
  );
  console.log(`✅ user_companies: user ${user.id} → company ${companyId}`);
}

    // Return JWT with full user details
    return res.status(200).json({
      status: "success",
      message: "Connector paired successfully",
      jwt_token: jwtToken,
      company_id: companyId,  // ✅ Return company_id too
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        first_name: user.first_name,
        last_name: user.last_name
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