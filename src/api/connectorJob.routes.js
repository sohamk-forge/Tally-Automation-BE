import express from "express";
import pool from "../db/index.js";
import authMiddleware from "../middleware/auth.middleware.js";
import { DB_SCHEMA } from "../config/db.js";

import {
  applyConnectorJobResult,
  ConnectorJobNotFoundError
} from "../services/connectorJobResult.service.js";

const router = express.Router();

/**
 * Resolves the company a connector is paired with from its JWT
 * (id = user_id, machine_id = paired machine), the same lookup
 * connector.routes.js's GET /current already does, scoped down
 * to this specific machine and requiring the company_id backfilled
 * onto connector_machines.
 */
async function resolveConnectorCompanyId(req) {

  const { id: userId, machine_id: machineId } = req.user || {};

  if (!machineId) {
    return null;
  }

  const result = await pool.query(
    `
    SELECT company_id
    FROM ${DB_SCHEMA}.connector_machines
    WHERE user_id = $1
      AND machine_id = $2
      AND tally_connected = true
    ORDER BY updated_at DESC
    LIMIT 1
    `,
    [userId, machineId]
  );

  return result.rows[0]?.company_id || null;
}

/* =========================================
   POLL FOR NEXT PENDING JOB
========================================= */

router.post("/jobs/poll", authMiddleware, async (req, res) => {
  try {

    if (!req.user?.machine_id) {
      return res.status(403).json({
        status: "error",
        message: "Connector authentication required"
      });
    }

    const companyId = await resolveConnectorCompanyId(req);

    if (!companyId) {
      return res.status(404).json({
        status: "error",
        message: "No paired company found for this connector"
      });
    }

    const claimResult = await pool.query(
      `
      UPDATE ${DB_SCHEMA}.job_logs
      SET status = 'in_progress', claimed_at = NOW()
      WHERE id = (
        SELECT id
        FROM ${DB_SCHEMA}.job_logs
        WHERE status = 'pending'
          AND company_id = $1
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, job_type, xml, company, source_type, source_id
      `,
      [companyId]
    );

    if (claimResult.rows.length === 0) {
      return res.status(204).send();
    }

    return res.status(200).json({
      status: "success",
      job: claimResult.rows[0]
    });

  } catch (err) {

    console.error("Connector Poll Error:", err);

    return res.status(500).json({
      status: "error",
      message: err.message
    });

  }
});

/* =========================================
   POST JOB EXECUTION RESULT
========================================= */

router.post("/jobs/:id/result", authMiddleware, async (req, res) => {
  try {

    if (!req.user?.machine_id) {
      return res.status(403).json({
        status: "error",
        message: "Connector authentication required"
      });
    }

    const companyId = await resolveConnectorCompanyId(req);

    if (!companyId) {
      return res.status(404).json({
        status: "error",
        message: "No paired company found for this connector"
      });
    }

    const { raw_response, error_message } = req.body;

    if (!raw_response && !error_message) {
      return res.status(400).json({
        status: "error",
        message: "raw_response or error_message is required"
      });
    }

    const job = await applyConnectorJobResult({
      job_id: req.params.id,
      company_id: companyId,
      raw_response,
      error_message
    });

    return res.status(200).json({
      status: "success",
      job
    });

  } catch (err) {

    if (err instanceof ConnectorJobNotFoundError) {
      return res.status(404).json({
        status: "error",
        message: err.message
      });
    }

    console.error("Connector Result Error:", err);

    return res.status(500).json({
      status: "error",
      message: err.message
    });

  }
});

export default router;
