import express from "express";
import crypto from "crypto";
import pool from "../db/index.js";
import { hashApiKey } from "../middleware/apiKey.middleware.js";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

router.post("/pair", async (req, res) => {

  const client = await pool.connect();

  try {

    const {
      token,
      machine_id,
      company_name
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

    // Validate company_name
    if (!company_name) {
      return res.status(400).json({
        status: "error",
        message: "company_name is required"
      });
    }

    await client.query("BEGIN");

    // Lock the pairing token row so a concurrent request can't read it
    // before this one marks it used
    const result = await client.query(
      `
      SELECT *
      FROM ${DB_SCHEMA}.connector_pairing_tokens
      WHERE token = $1
      LIMIT 1
      FOR UPDATE
      `,
      [token]
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: "error",
        message: "Invalid token"
      });
    }

    const pairingToken = result.rows[0];

    if (pairingToken.is_used) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: "error",
        message: "Token already used"
      });
    }

    if (new Date(pairingToken.expires_at) < new Date()) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: "error",
        message: "Token expired"
      });
    }

    // Fetch user
    const userResult = await client.query(
      `
      SELECT *
      FROM ${DB_SCHEMA}.users
      WHERE id = $1
      LIMIT 1
      `,
      [pairingToken.user_id]
    );

    if (userResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    const user = userResult.rows[0];

    // Company identity is scoped per user: a name match against another
    // user's company must never grant this user access to that row (the
    // shared-company_id bug this fixes — connector_pairing_tokens is the
    // real access-control source, not user_companies). Only reuse a
    // company row this user already owns via a used pairing token for the
    // same (trimmed, case-insensitive) name; otherwise always create a new
    // row, even if another unrelated user already owns that exact name.
    const ownedCompanyResult = await client.query(
      `
      SELECT c.id
      FROM ${DB_SCHEMA}.companies c
      JOIN ${DB_SCHEMA}.connector_pairing_tokens cpt ON cpt.company_id = c.id
      WHERE cpt.user_id = $1
        AND cpt.is_used = TRUE
        AND lower(trim(c.name)) = lower(trim($2))
      LIMIT 1
      `,
      [user.id, company_name]
    );

    let companyId;

    if (ownedCompanyResult.rows.length > 0) {
      companyId = ownedCompanyResult.rows[0].id;
    } else {
      const companyInsertResult = await client.query(
        `
        INSERT INTO ${DB_SCHEMA}.companies (name)
        VALUES ($1)
        RETURNING id
        `,
        [company_name]
      );
      companyId = companyInsertResult.rows[0].id;

      // The user who first pairs a company is its admin. Later invited
      // members get their company_members row from invite-approval instead
      // (see invite.service.js) — this only covers first-time creation.
      await client.query(
        `
        INSERT INTO ${DB_SCHEMA}.company_members (user_id, company_id, role)
        VALUES ($1, $2, 'admin')
        ON CONFLICT (user_id, company_id) DO NOTHING
        `,
        [user.id, companyId]
      );
    }

    // Record that this user now has access to this company. ON CONFLICT
    // because a user can pair multiple machines to the same company.
    await client.query(
      `
      INSERT INTO ${DB_SCHEMA}.user_companies (user_id, company_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, company_id) DO NOTHING
      `,
      [user.id, companyId]
    );

    // Only admin/accountant roles may pair a connector device, one device
    // per role per company. A brand-new company always passes this for its
    // creator, since the company_members insert above just made them
    // 'admin' earlier in this same transaction.
    const memberRoleResult = await client.query(
      `
      SELECT role
      FROM ${DB_SCHEMA}.company_members
      WHERE user_id = $1 AND company_id = $2
      LIMIT 1
      `,
      [user.id, companyId]
    );

    const memberRole = memberRoleResult.rows[0]?.role;

    if (memberRole !== "admin" && memberRole !== "accountant") {
      await client.query("ROLLBACK");
      return res.status(403).json({
        status: "error",
        message: "Your role does not permit connector pairing"
      });
    }

    const conflictingKeyResult = await client.query(
      `
      SELECT cak.id, u.email
      FROM ${DB_SCHEMA}.connector_api_keys cak
      JOIN ${DB_SCHEMA}.company_members cm
        ON cm.company_id = cak.company_id AND cm.user_id = cak.user_id
      JOIN ${DB_SCHEMA}.users u ON u.id = cak.user_id
      WHERE cak.company_id = $1
        AND cm.role = $2
        AND cak.user_id != $3
        AND cak.revoked_at IS NULL
      LIMIT 1
      `,
      [companyId, memberRole, user.id]
    );

    if (conflictingKeyResult.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        status: "error",
        message: `An existing ${memberRole} device is already paired for this company (by ${conflictingKeyResult.rows[0].email})`
      });
    }

    // Re-pairing a new machine under the same user+company replaces their
    // existing device rather than stacking a second one.
    await client.query(
      `
      UPDATE ${DB_SCHEMA}.connector_api_keys
      SET revoked_at = NOW()
      WHERE user_id = $1 AND company_id = $2 AND revoked_at IS NULL
      `,
      [user.id, companyId]
    );

    // Generate a long-lived, revocable API key for this machine (shown once —
    // only its hash is stored). Replaces the old 30-day JWT.
    const apiKey = crypto.randomBytes(32).toString("hex");
    const keyHash = hashApiKey(apiKey);

    await client.query(
      `
      INSERT INTO ${DB_SCHEMA}.connector_api_keys
      (
        user_id,
        machine_id,
        key_hash,
        company_id
      )
      VALUES
      (
        $1,
        $2,
        $3,
        $4
      )
      `,
      [
        user.id,
        machine_id,
        keyHash,
        companyId
      ]
    );

    // Mark token as used and verify update succeeded
    const updateResult = await client.query(
      `
      UPDATE ${DB_SCHEMA}.connector_pairing_tokens
      SET
        is_used = TRUE,
        machine_id = $1,
        company_id = $2
      WHERE id = $3
      RETURNING id
      `,
      [
        machine_id,
        companyId,
        pairingToken.id
      ]
    );

    if (updateResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(500).json({
        status: "error",
        message: "Failed to update pairing token"
      });
    }

    await client.query("COMMIT");

    // Best-effort claim of this machine's connector_machines row (outside
    // the transaction, after commit — this table is display-only, per the
    // scoping note in companies.routes.js, never used for access control,
    // so it must never be allowed to fail the actual pairing). If the
    // connector already sent a heartbeat before pairing, its user_id is a
    // negative placeholder (see derivePlaceholderUserId in the connector's
    // heartbeat.service.js); matched by machine_id, unique per physical
    // machine. connector_machines.user_id also has its own unique
    // constraint — a user re-pairing a second machine would violate it
    // here, which is fine to just log and move on from.
    try {
      await pool.query(
        `
        UPDATE ${DB_SCHEMA}.connector_machines
        SET user_id = $1, updated_at = NOW()
        WHERE machine_id = $2 AND user_id < 0
        `,
        [user.id, machine_id]
      );
    } catch (claimErr) {
      console.error("connector_machines claim failed (non-fatal):", claimErr.message);
    }

    // Return the API key with full user details — the raw key is only ever
    // shown here, the connector app must store it locally.
    return res.status(200).json({
      status: "success",
      message: "Connector paired successfully",
      api_key: apiKey,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        first_name: user.first_name,
        last_name: user.last_name
      }
    });

  } catch (err) {

    await client.query("ROLLBACK").catch(() => {});
    console.error(err);

    return res.status(500).json({
      status: "error",
      message: err.message
    });

  } finally {
    client.release();
  }

});

export default router;