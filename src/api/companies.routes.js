import express from "express";
import pool from "../db/index.js";
import { resolveUserId } from "../utils/resolveUserId.js";
import { getCompanyMemberRole, checkSeatAvailable } from "../utils/companyMembers.js";
import { PAGE_KEYS, EDITABLE_ROLES, getRolePermissionMatrix, getEnabledPagesForRole } from "../utils/pagePermissions.js";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

/* =========================================
   SCOPING NOTE

   companies is a shared table with no owner column. Authorization comes from
   connector_pairing_tokens (user_id + company_id): a user may see a company
   only if THEY have a used pairing token for it.

   Previously these endpoints joined connector_machines on
   c.name = m.company_name with no user filter at all, so every user saw every
   connected company - a brand new account saw the full list on first login.

   Why pairing tokens and not connector_machines:
     - connector_machines is not reliably populated (user 29 has completed jobs
       all day but no machine row), so scoping on it would hide companies from
       legitimate users.
     - Joining on company_id avoids the c.name = m.company_name string match,
       which this project has already been bitten by via company-name truncation.

   connector_machines is still LEFT JOINed, but only to supply display fields
   (from_year, to_year, tally_connected). A missing machine row leaves those
   null instead of hiding the company.

   DISTINCT is required: a user typically has many pairing tokens for the same
   company (company 1 has dozens), which would otherwise duplicate every row
   and break the pagination count.
========================================= */

/* =========================================
   GET ALL COMPANIES (paginated, current user only)
========================================= */
router.get("/", async (req, res) => {
  try {
    const userId = await resolveUserId(req);

    if (!userId) {
      return res.status(404).json({
        status: "error",
        message: "No profile found for this account"
      });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    // COUNT TOTAL
    const totalResult = await pool.query(
      `SELECT COUNT(DISTINCT c.id)
       FROM ${DB_SCHEMA}.companies c
       INNER JOIN ${DB_SCHEMA}.connector_pairing_tokens cpt
           ON c.id = cpt.company_id
       WHERE cpt.user_id = $1
         AND cpt.is_used = TRUE`,
      [userId]
    );

    const total = parseInt(totalResult.rows[0].count);

    // FETCH COMPANIES
    const result = await pool.query(
      `SELECT DISTINCT
         c.id,
         c.name,
         c.financial_year_start,
         c.financial_year_end,
         m.from_year,
         m.to_year,
         m.tally_connected
       FROM ${DB_SCHEMA}.companies c
       INNER JOIN ${DB_SCHEMA}.connector_pairing_tokens cpt
           ON c.id = cpt.company_id
       LEFT JOIN ${DB_SCHEMA}.connector_machines m
           ON m.company_name = c.name
          AND m.user_id = cpt.user_id
       WHERE cpt.user_id = $1
         AND cpt.is_used = TRUE
       ORDER BY c.id DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    return res.json({
      status: "success",
      message: "Companies fetched successfully",
      page,
      limit,
      total,
      count: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    console.log("COMPANY GET ERROR:", err);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

/* =========================================
   GET SINGLE COMPANY BY ID (current user only)
   Without the user filter any caller could read any company by guessing
   an integer id.
========================================= */
router.get("/:id", async (req, res) => {
  try {
    const userId = await resolveUserId(req);

    if (!userId) {
      return res.status(404).json({
        status: "error",
        message: "No profile found for this account"
      });
    }

    const { id } = req.params;

    const result = await pool.query(
      `SELECT DISTINCT
         c.id,
         c.name,
         c.financial_year_start,
         c.financial_year_end,
         m.from_year,
         m.to_year,
         m.tally_connected
       FROM ${DB_SCHEMA}.companies c
       INNER JOIN ${DB_SCHEMA}.connector_pairing_tokens cpt
           ON c.id = cpt.company_id
       LEFT JOIN ${DB_SCHEMA}.connector_machines m
           ON m.company_name = c.name
          AND m.user_id = cpt.user_id
       WHERE c.id = $1
         AND cpt.user_id = $2
         AND cpt.is_used = TRUE`,
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Company not found"
      });
    }

    return res.json({
      status: "success",
      data: result.rows[0]
    });

  } catch (err) {
    console.log("COMPANY GET BY ID ERROR:", err);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

/* =========================================
   GET ALL COMPANIES (SIMPLE, current user only)
========================================= */
router.get("/all/list", async (req, res) => {
  try {
    const userId = await resolveUserId(req);

    if (!userId) {
      return res.status(404).json({
        status: "error",
        message: "No profile found for this account"
      });
    }

    const result = await pool.query(
      `SELECT DISTINCT
         c.id,
         c.name,
         c.financial_year_start,
         c.financial_year_end,
         m.from_year,
         m.to_year,
         m.tally_connected
       FROM ${DB_SCHEMA}.companies c
       INNER JOIN ${DB_SCHEMA}.connector_pairing_tokens cpt
           ON c.id = cpt.company_id
       LEFT JOIN ${DB_SCHEMA}.connector_machines m
           ON m.company_name = c.name
          AND m.user_id = cpt.user_id
       WHERE cpt.user_id = $1
         AND cpt.is_used = TRUE
       ORDER BY c.id DESC`,
      [userId]
    );

    return res.json({
      status: "success",
      count: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    console.log("COMPANY LIST ERROR:", err);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});
  
/* =========================================
   MY ROLE — unlike GET /:id/members (admin-only), any member can check
   their own role. This is what the frontend uses to decide which pages/
   nav items to show for the active company.
========================================= */
router.get("/:id/my-role", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) {
      return res.status(404).json({ status: "error", message: "No profile found for this account" });
    }

    const role = await getCompanyMemberRole(userId, req.params.id);

    if (!role) {
      return res.status(404).json({ status: "error", message: "You are not a member of this company" });
    }

    // Admin always sees every page — the permission matrix only ever
    // applies to accountant/staff, so it's not even consulted here.
    const enabledPages = role === "admin"
      ? [...PAGE_KEYS]
      : await getEnabledPagesForRole(req.params.id, role);

    return res.json({ status: "success", data: { role, enabledPages } });
  } catch (err) {
    console.log("COMPANY MY ROLE ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* =========================================
   ROLE PAGE PERMISSIONS — admin-only. Controls which pages Accountant and
   Staff can see, per company. Admin is intentionally not represented here
   at all (always full access) and "team" (Team & Access) is intentionally
   not in PAGE_KEYS (always admin-only) — neither is ever toggle-able.
========================================= */
router.get("/:id/role-permissions", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) {
      return res.status(404).json({ status: "error", message: "No profile found for this account" });
    }

    const companyId = req.params.id;
    const callerRole = await getCompanyMemberRole(userId, companyId);
    if (callerRole !== "admin") {
      return res.status(403).json({ status: "error", message: "Only an admin can view page permissions" });
    }

    const matrix = await getRolePermissionMatrix(companyId);
    return res.json({ status: "success", data: { pages: PAGE_KEYS, matrix } });
  } catch (err) {
    console.log("ROLE PERMISSIONS GET ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

router.patch("/:id/role-permissions", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) {
      return res.status(404).json({ status: "error", message: "No profile found for this account" });
    }

    const companyId = req.params.id;
    const { role, pageKey, enabled } = req.body;

    if (!EDITABLE_ROLES.includes(role)) {
      return res.status(400).json({ status: "error", message: `role must be one of: ${EDITABLE_ROLES.join(", ")}` });
    }
    if (!PAGE_KEYS.includes(pageKey)) {
      return res.status(400).json({ status: "error", message: "Unknown pageKey" });
    }
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ status: "error", message: "enabled must be true or false" });
    }

    const callerRole = await getCompanyMemberRole(userId, companyId);
    if (callerRole !== "admin") {
      return res.status(403).json({ status: "error", message: "Only an admin can change page permissions" });
    }

    await pool.query(
      `
      INSERT INTO ${DB_SCHEMA}.company_role_permissions (company_id, role, page_key, enabled)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (company_id, role, page_key)
      DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
      `,
      [companyId, role, pageKey, enabled]
    );

    const matrix = await getRolePermissionMatrix(companyId);
    return res.json({ status: "success", data: { pages: PAGE_KEYS, matrix } });
  } catch (err) {
    console.log("ROLE PERMISSIONS PATCH ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* =========================================
   COMPANY MEMBERS — list / change role / remove
   Admin-only: the caller must hold role='admin' in company_members for
   this company (checked via getCompanyMemberRole, not the legacy
   connector_pairing_tokens/user_companies access check — membership and
   data access are deliberately separate concerns here).
========================================= */
router.get("/:id/members", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) {
      return res.status(404).json({ status: "error", message: "No profile found for this account" });
    }

    const companyId = req.params.id;
    const callerRole = await getCompanyMemberRole(userId, companyId);

    if (callerRole !== "admin") {
      return res.status(403).json({ status: "error", message: "Only an admin can view company members" });
    }

    const result = await pool.query(
      `
      SELECT
        u.id AS user_id,
        u.email,
        u.first_name,
        u.last_name,
        cm.role,
        EXISTS (
          SELECT 1 FROM ${DB_SCHEMA}.connector_api_keys cak
          WHERE cak.user_id = u.id
            AND cak.company_id = $1
            AND cak.revoked_at IS NULL
        ) AS has_device
      FROM ${DB_SCHEMA}.company_members cm
      JOIN ${DB_SCHEMA}.users u ON u.id = cm.user_id
      WHERE cm.company_id = $1
      ORDER BY cm.role, u.email
      `,
      [companyId]
    );

    return res.json({ status: "success", data: result.rows });
  } catch (err) {
    console.log("COMPANY MEMBERS LIST ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

router.patch("/:id/members/:memberId", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) {
      return res.status(404).json({ status: "error", message: "No profile found for this account" });
    }

    const companyId = req.params.id;
    const memberId = req.params.memberId;
    const { role } = req.body;

    if (!["admin", "accountant", "staff"].includes(role)) {
      return res.status(400).json({ status: "error", message: "role must be one of: admin, accountant, staff" });
    }

    const callerRole = await getCompanyMemberRole(userId, companyId);
    if (callerRole !== "admin") {
      return res.status(403).json({ status: "error", message: "Only an admin can change a member's role" });
    }

    const seatCheck = await checkSeatAvailable(companyId, role, memberId);
    if (!seatCheck.available) {
      return res.status(409).json({
        status: "error",
        message: seatCheck.reason === "seat_taken"
          ? `The ${role} seat for this company is already taken by ${seatCheck.takenBy}`
          : "This company already has the maximum number of staff members"
      });
    }

    const result = await pool.query(
      `
      UPDATE ${DB_SCHEMA}.company_members
      SET role = $1
      WHERE company_id = $2 AND user_id = $3
      RETURNING user_id, role
      `,
      [role, companyId, memberId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ status: "error", message: "Member not found on this company" });
    }

    // Any role change clears this member's existing device pairing for the
    // company — otherwise someone demoted off admin/accountant would keep
    // an active connector device despite the role no longer permitting one,
    // and re-pairing under the new role is a cheap one-time action anyway.
    await pool.query(
      `
      UPDATE ${DB_SCHEMA}.connector_api_keys
      SET revoked_at = NOW()
      WHERE user_id = $1 AND company_id = $2 AND revoked_at IS NULL
      `,
      [memberId, companyId]
    );

    return res.json({ status: "success", data: result.rows[0] });
  } catch (err) {
    console.log("COMPANY MEMBER ROLE UPDATE ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

router.delete("/:id/members/:memberId", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) {
      return res.status(404).json({ status: "error", message: "No profile found for this account" });
    }

    const companyId = req.params.id;
    const memberId = req.params.memberId;

    const callerRole = await getCompanyMemberRole(userId, companyId);
    if (callerRole !== "admin") {
      return res.status(403).json({ status: "error", message: "Only an admin can remove a member" });
    }
    if (String(memberId) === String(userId)) {
      return res.status(400).json({ status: "error", message: "An admin cannot remove their own access" });
    }

    await pool.query(
      `DELETE FROM ${DB_SCHEMA}.company_members WHERE company_id = $1 AND user_id = $2`,
      [companyId, memberId]
    );

    await pool.query(
      `DELETE FROM ${DB_SCHEMA}.connector_pairing_tokens WHERE company_id = $1 AND user_id = $2`,
      [companyId, memberId]
    );

    await pool.query(
      `
      UPDATE ${DB_SCHEMA}.connector_api_keys
      SET revoked_at = NOW()
      WHERE company_id = $1 AND user_id = $2 AND revoked_at IS NULL
      `,
      [companyId, memberId]
    );

    return res.json({ status: "success", message: "Member access removed" });
  } catch (err) {
    console.log("COMPANY MEMBER REMOVE ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

export default router;