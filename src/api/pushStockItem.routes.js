import { DB_SCHEMA } from "../config/db.js";
import express from "express";
import pool from "../db/index.js";
import {
  stockItemQueue,
  STOCK_ITEM_JOB_OPTIONS,
  getStockItemJobId
} from "../queues/stockItem.queue.js";
import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";

const router = express.Router();

/* =====================================================
  Resolve the caller's own paired company from
  connector_pairing_tokens — never from a name the client
  sent. This is the same fix already applied to
  pushLedger.routes.js: a by-name lookup with no user_id
  filter can resolve to a DIFFERENT company row than the
  one this user is actually paired to whenever two
  companies share a display name, which produced real
  cross-tenant pushes upstream of this file.
===================================================== */
async function getOwnCompany(userId) {
  const result = await pool.query(
    `
    SELECT cpt.company_id, c.name
    FROM ${DB_SCHEMA}.connector_pairing_tokens cpt
    JOIN ${DB_SCHEMA}.companies c
      ON c.id = cpt.company_id
    WHERE cpt.user_id = $1
      AND cpt.is_used = TRUE
    ORDER BY cpt.created_at DESC
    LIMIT 1
    `,
    [userId]
  );

  if (!result.rows.length) return null;

  return {
    companyId: result.rows[0].company_id,
    companyName: result.rows[0].name
  };
}

/* =====================================================
  Does this user have an active pairing for this specific
  companyId? Used to gate the status endpoint below, which
  previously trusted :companyId from the URL with no
  ownership check at all.
===================================================== */
async function userOwnsCompany(userId, companyId) {
  const result = await pool.query(
    `
    SELECT 1
    FROM ${DB_SCHEMA}.connector_pairing_tokens
    WHERE user_id = $1
      AND company_id = $2
      AND is_used = TRUE
    LIMIT 1
    `,
    [userId, companyId]
  );
  return result.rows.length > 0;
}

router.post("/push-stock-item", verifySession(), async (req, res) => {

  try {
    const userId = await getLocalUserId(req.session.getUserId());

    if (!userId) {
      return res.status(404).json({
        status: "error",
        message: "No profile found for this account"
      });
    }

    const data = req.body;
    console.log("Parent Group Received:", data.parent_group);

    console.log("====================================");
    console.log("PUSH STOCK ITEM API HIT");
    console.log("====================================");
    console.log(JSON.stringify(data, null, 2));

    // Validation 1: Required fields
    // NOTE: data.company is no longer required — company identity comes
    // from the caller's own pairing, not from a client-supplied name.
    if (!data.item_name || !data.unit) {
      return res.status(400).json({
        status: "error",
        message: "item_name and unit are required"
      });
    }

    // Validation 2: GST Applicable value
    const gstApplicable = data.gst_applicable || "Not Applicable";

    if (!["Applicable", "Not Applicable"].includes(gstApplicable)) {
      return res.status(400).json({
        status: "error",
        message: "gst_applicable must be 'Applicable' or 'Not Applicable'"
      });
    }

    // Validation 3: Resolve company from the caller's own pairing
    const ownCompany = await getOwnCompany(userId);

    if (!ownCompany) {
      return res.status(400).json({
        status: "error",
        message: "No paired company found for this user."
      });
    }

    const { companyId, companyName } = ownCompany;

    // data.company, if the frontend still sends it, is informational
    // only — never used to resolve identity.
    if (data.company && data.company.trim() !== companyName) {
      console.warn(
        `⚠️ PUSH STOCK ITEM: request named "${data.company}" but resolved to owner's paired company "${companyName}" (id=${companyId}) for user ${userId}`
      );
    }

    console.log("✅ COMPANY SELECTED:", { companyId, companyName, userId });

    // Check if stock item already exists
    const existingItem = await pool.query(
      `
      SELECT id
      FROM ${DB_SCHEMA}.push_stock_item
      WHERE company_id = $1
        AND TRIM(item_name) = TRIM($2)
      LIMIT 1
      `,
      [companyId, data.item_name?.trim()]
    );

    let stockItemRecord;

    if (existingItem.rows.length > 0) {

      console.log(`Updating existing stock item: ${data.item_name}`);

      const updateResult = await pool.query(
        `
        UPDATE ${DB_SCHEMA}.push_stock_item
        SET
          company_name = $1,
          alias_name = $2,
          unit_name = $3,
          description = $4,
          hsn_code = $5,
          cgst_rate = $6,
          sgst_rate = $7,
          igst_rate = $8,
          gst_applicable = $9,
          parent_group = $10,
          opening_quantity = $11,
          opening_rate = $12,
          opening_value = $13,
          status = 'pending',
          error_count = 0,
          last_error = NULL,
          updated_at = NOW()
        WHERE id = $14
        RETURNING *
        `,
        [
          companyName,
          data.alias_name || "",
          data.unit?.trim(),
          data.description || "",
          data.hsn_code || "",
          data.cgst_rate || 0,
          data.sgst_rate || 0,
          data.igst_rate || 0,
          gstApplicable,
          data.parent_group || "",
          Number(data.opening_quantity || 0),
          Number(data.opening_rate || 0),
          Number(data.opening_value || 0),
          existingItem.rows[0].id
        ]
      );

      stockItemRecord = updateResult.rows[0];
      console.log("Updated Parent Group:", stockItemRecord.parent_group);

    } else {

      console.log(`Creating new stock item: ${data.item_name}`);

      const insertResult = await pool.query(
        `
        INSERT INTO ${DB_SCHEMA}.push_stock_item (
          company_id,
          company_name,
          item_name,
          alias_name,
          unit_name,
          description,
          hsn_code,
          cgst_rate,
          sgst_rate,
          igst_rate,
          gst_applicable,
          parent_group,
          opening_quantity,
          opening_rate,
          opening_value,
          status,
          created_at,
          updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
          $13,$14,$15,
          'pending',
          NOW(),
          NOW()
        )
        RETURNING *
        `,
        [
          companyId,
          companyName,
          data.item_name?.trim(),
          data.alias_name || "",
          data.unit?.trim(),
          data.description || "",
          data.hsn_code || "",
          data.cgst_rate || 0,
          data.sgst_rate || 0,
          data.igst_rate || 0,
          gstApplicable,
          data.parent_group || "",
          Number(data.opening_quantity || 0),
          Number(data.opening_rate || 0),
          Number(data.opening_value || 0)
        ]
      );

      stockItemRecord = insertResult.rows[0];
      console.log("Saved Parent Group:", stockItemRecord.parent_group);
    }

    console.log(`Stock item ${existingItem.rows.length > 0 ? 'updated' : 'created'}: ${data.item_name}`);

    // Queue Job
    const jobId = getStockItemJobId(stockItemRecord.id);
    const existingJob = await stockItemQueue.getJob(jobId);

    if (existingJob) {
      const state = await existingJob.getState();
      if (["completed", "failed"].includes(state)) {
        await existingJob.remove();
      } else if (["active", "waiting", "delayed"].includes(state)) {
        return res.status(200).json({
          status: "success",
          message: "Push already in progress for this item",
          data: stockItemRecord
        });
      }
    }

    await stockItemQueue.add(
      "push-stock-item",
      {
        stockItemId: stockItemRecord.id,
        userId
      },
      {
        ...STOCK_ITEM_JOB_OPTIONS,
        jobId
      }
    );

    return res.status(200).json({
      status: "success",
      message: existingItem.rows.length > 0
        ? "Stock item updated and queued successfully"
        : "Stock item created and queued successfully",
      data: stockItemRecord
    });

  } catch (err) {
    console.log("ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});


// Get status by specific item name — now ownership-checked
router.get(
  "/push/stock-item/status/:companyId",
  verifySession(),
  async (req, res) => {
  try {
    console.log("STATUS API HIT");

    const userId = await getLocalUserId(req.session.getUserId());

    if (!userId) {
      return res.status(404).json({
        status: "error",
        message: "No profile found for this account"
      });
    }

    const { companyId } = req.params;
    const { status, item_name, error_only } = req.query;

    const owns = await userOwnsCompany(userId, companyId);
    if (!owns) {
      return res.status(403).json({
        status: "error",
        message: "This company is not paired with your account."
      });
    }

    let query = `
      SELECT
        id,
        company_id,
        company_name,
        item_name,
        alias_name,
        unit_name,
        description,
        hsn_code,
        cgst_rate,
        sgst_rate,
        igst_rate,
        gst_applicable,
        parent_group,
        opening_quantity,
        opening_rate,
        opening_value,
        status,
        error_count,
        last_error,
        tally_response,
        created_at,
        updated_at
      FROM ${DB_SCHEMA}.push_stock_item
      WHERE company_id = $1
    `;
    const params = [companyId];

    if (status) {
      query += ` AND status = $${params.length + 1}`;
      params.push(status);
    }

    if (item_name) {
      query += ` AND LOWER(TRIM(item_name)) = LOWER(TRIM($${params.length + 1}))`;
      params.push(item_name);
    }

    if (error_only === "true") {
      query += ` AND error_count > 0`;
    }

    query += ` ORDER BY id DESC`;

    const result = await pool.query(query, params);

    // Split into groups so frontend can render/retry easily
    const failedItems = result.rows.filter(r => r.status === "failed");
    const pendingItems = result.rows.filter(r => r.status === "pending");
    const successItems = result.rows.filter(r => r.status === "success");

    return res.status(200).json({
      status: "success",
      count: result.rowCount,
      summary: {
        total: result.rowCount,
        success: successItems.length,
        pending: pendingItems.length,
        failed: failedItems.length
      },
      data: result.rows,
      failedItems,     // full row data per failed item — use to auto-fill the retry form
      pendingItems,
      successItems
    });

  } catch (err) {
    console.log(err);

    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;