import express from "express";
import pool from "../db/index.js";
import authMiddleware from "../middleware/auth.middleware.js";
import { checkCompanyAccess } from "../utils/companyAccess.js";
import {
  stockAlertQueue,
  STOCK_ALERT_JOB_OPTIONS,
  getStockAlertJobId
} from "../queues/stockAlert.queue.js";

const router = express.Router();

router.post("/push-stock-alert", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const data = req.body;

    if (
      !data.company ||
      !data.item_name ||
      data.minimum_alert_quantity == null
    ) {
      return res.status(400).json({
        status: "error",
        message:
          "company, item_name and minimum_alert_quantity are required"
      });
    }

    const companyResult = await pool.query(
      `SELECT id FROM app_test.companies
       WHERE TRIM(name) = TRIM($1) LIMIT 1`,
      [data.company]
    );

    const companyId = companyResult.rows[0]?.id || null;

    if (!companyId) {
      return res.status(400).json({
        status: "error",
        message: `Company '${data.company}' not found`
      });
    }

    const hasAccess = await checkCompanyAccess(userId, companyId);
    if (!hasAccess) {
      return res.status(403).json({
        status: "error",
        message: "You don't have access to this company"
      });
    }

    const existingResult = await pool.query(
      `SELECT id FROM app_test.stock_alerts
       WHERE
         LOWER(TRIM(company_name)) = LOWER(TRIM($1))
       AND
         LOWER(TRIM(item_name)) = LOWER(TRIM($2))
       LIMIT 1`,
      [data.company, data.item_name]
    );

    if (existingResult.rows.length) {
      await pool.query(
        `UPDATE app_test.stock_alerts
         SET
           minimum_alert_quantity = $1,
           is_active = true,
           updated_at = NOW()
         WHERE id = $2`,
        [
          Number(data.minimum_alert_quantity),
          existingResult.rows[0].id
        ]
      );

      await stockAlertQueue.add(
        "stock-alert",
        {
          companyId,
          userId
        },
        {
          ...STOCK_ALERT_JOB_OPTIONS,
          jobId: `${companyId}-${Date.now()}`
        }
      );

      return res.status(200).json({
        status: "success",
        message: "Stock alert updated successfully",
        company_id: companyId,
        alertId: existingResult.rows[0].id
      });
    }

    const insertResult = await pool.query(
      `INSERT INTO app_test.stock_alerts
       (
         company_id,
         company_name,
         item_name,
         minimum_alert_quantity,
         is_active,
         created_at,
         updated_at
       )
       VALUES ($1, $2, $3, $4, true, NOW(), NOW())
       RETURNING id`,
      [
        companyId,
        data.company?.trim(),
        data.item_name?.trim(),
        Number(data.minimum_alert_quantity)
      ]
    );

    const alertId = insertResult.rows[0].id;

    await stockAlertQueue.add(
      "stock-alert",
      {
        companyId,
        userId
      },
      {
        ...STOCK_ALERT_JOB_OPTIONS,
        jobId: `${companyId}-${Date.now()}`
      }
    );

    return res.status(200).json({
      status: "success",
      message: "Stock alert created successfully",
      company_id: companyId,
      alertId
    });

  } catch (err) {
    console.error("❌ STOCK ALERT ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;