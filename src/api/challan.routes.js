/**
 * src/api/challan.routes.js
 *
 * Register in app.js:
 *   import challanRoutes from "./api/challan.routes.js";
 *   app.use("/api/v1/challan", challanRoutes);
 *
 * ─────────────────────────────────────────────
 * ENDPOINTS
 * ─────────────────────────────────────────────
 *
 * POST   /api/v1/challan/create      → ONE API: auto-sets prefix on first
 *                                       call for a company, then creates the
 *                                       challan with an auto-incremented
 *                                       number. On every later call, "prefix"
 *                                       (if sent) is ignored — the format
 *                                       stays static as required.
 * GET    /api/v1/challan/prefix      → (optional) preview current prefix +
 *                                       what the next number will be
 * GET    /api/v1/challan/all         → list all challans (with filters)
 * GET    /api/v1/challan/:id         → single challan with items
 * PATCH  /api/v1/challan/:id/status  → update status (DRAFT/CONFIRMED/CANCELLED)
 */

import express from "express";
import {
  getPrefix,
  createChallan,
  getAllChallans,
  getChallanById,
  updateChallanStatus,
} from "../services/challan.service.js";

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────

function errRes(res, status, message, details) {
  return res.status(status).json({
    success: false,
    error:   message,
    ...(details ? { details } : {}),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/challan/create
//
// ONE API — creates the challan, and if this is the company's very first
// challan, saves the "prefix" you send along with it. After that, the
// prefix is locked and any "prefix" field you send is simply ignored.
//
// Body (JSON) — first call for a company:
// {
//   "company_id":       1,
//   "company_name":     "Sai Computech",
//   "prefix":           "25-26/",              ← only needed the FIRST time
//   "pad_length":        4,                     ← optional, default 4
//   "challan_date":     "2026-07-01",
//   "customer_name":    "ABC Traders",
//   "customer_gstin":   "27AABCE9378F5ZG",     ← optional
//   "customer_address": "Mumbai",               ← optional
//   "narration":        "Goods delivered",      ← optional
//   "supply_type":      "intrastate",           ← "intrastate" | "interstate"
//   "items": [
//     {
//       "item_name":         "Item A",
//       "godown_name":       "Main Store",      ← optional
//       "hsn_code":          "8471",            ← optional
//       "qty":               10,
//       "rate":              500,
//       "gst_rate":          "18%",             ← "0%" | "5%" | "12%" | "18%" | "28%"
//       "discount_percent":  5,                 ← optional, default 0
//       "sort_order":        0                  ← optional
//     }
//   ]
// }
//
// Body (JSON) — every call after that: same as above, just drop "prefix".
//
// Response 201:
// {
//   "success": true,
//   "message": "Challan 25-26/0001 created successfully",
//   "data": {
//     "id": 1,
//     "challan_number": "25-26/0001",
//     "challan_date": "2026-07-01",
//     "customer_name": "ABC Traders",
//     "grand_total": 5225.00,
//     "status": "DRAFT",
//     "prefix_used": "25-26/",
//     "prefix_just_created": true,
//     "items": [ ... ]
//   }
// }
// ─────────────────────────────────────────────────────────────────────────────

router.post("/create", async (req, res) => {
  try {
    const {
      company_id, company_name, prefix, pad_length,
      challan_date, customer_name, customer_gstin, customer_address,
      narration, supply_type, items,
    } = req.body;

    if (!company_id)   return errRes(res, 400, "company_id is required");
    if (!challan_date) return errRes(res, 400, "challan_date is required");
    if (!Array.isArray(items) || items.length === 0) {
      return errRes(res, 400, "items[] array with at least one item is required");
    }

    const challan = await createChallan({
      company_id: Number(company_id),
      company_name,
      prefix,
      pad_length,
      challan_date,
      customer_name,
      customer_gstin,
      customer_address,
      narration,
      supply_type,
      items,
    });

    return res.status(201).json({
      success: true,
      message: `Challan ${challan.challan_number} created successfully`,
      data:    challan,
    });
  } catch (err) {
    console.error("[Challan] create:", err.message);
    // Prefix missing on first-ever call for this company
    if (err.message.includes("No challan prefix configured")) {
      return errRes(res, 422, err.message);
    }
    return errRes(res, 500, err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/challan/prefix?company_id=1
//
// Optional helper for the frontend — preview the current prefix and what
// the NEXT challan number will look like before actually creating one.
// ─────────────────────────────────────────────────────────────────────────────

router.get("/prefix", async (req, res) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return errRes(res, 400, "company_id is required");

    const settings = await getPrefix(Number(company_id));
    if (!settings) {
      return errRes(
        res, 404,
        "No prefix configured yet for this company. Send 'prefix' with your first POST /create call."
      );
    }

    const nextNum = Number(settings.last_number) + 1;
    const padded  = String(nextNum).padStart(settings.pad_length, "0");

    return res.status(200).json({
      success: true,
      data: {
        ...settings,
        next_challan_number: `${settings.prefix}${padded}`,
      },
    });
  } catch (err) {
    console.error("[Challan] get-prefix:", err.message);
    return errRes(res, 500, err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/challan/all?company_id=1&status=DRAFT&from_date=2026-04-01&to_date=2026-06-30
//
// Returns all challans for a company (header only, no items).
// Optional filters: status, from_date, to_date, customer_name
// ─────────────────────────────────────────────────────────────────────────────

router.get("/all", async (req, res) => {
  try {
    const { company_id, status, from_date, to_date, customer_name } = req.query;

    if (!company_id) return errRes(res, 400, "company_id is required");

    const challans = await getAllChallans(Number(company_id), {
      status,
      from_date,
      to_date,
      customer_name,
    });

    return res.status(200).json({
      success: true,
      count:   challans.length,
      data:    challans,
    });
  } catch (err) {
    console.error("[Challan] all:", err.message);
    return errRes(res, 500, err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/challan/:id?company_id=1
//
// Returns single challan with all line items.
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id", async (req, res) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return errRes(res, 400, "company_id is required");

    const challan = await getChallanById(Number(req.params.id), Number(company_id));
    if (!challan) {
      return errRes(res, 404, "Challan not found");
    }

    return res.status(200).json({ success: true, data: challan });
  } catch (err) {
    console.error("[Challan] get-by-id:", err.message);
    return errRes(res, 500, err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/v1/challan/:id/status
//
// Update challan status.
// Body: { "company_id": 1, "status": "CONFIRMED" }
// Allowed: DRAFT | CONFIRMED | CANCELLED
// ─────────────────────────────────────────────────────────────────────────────

router.patch("/:id/status", async (req, res) => {
  try {
    const { company_id, status } = req.body;
    if (!company_id) return errRes(res, 400, "company_id is required");
    if (!status)     return errRes(res, 400, "status is required");

    const updated = await updateChallanStatus(
      Number(req.params.id),
      Number(company_id),
      status.toUpperCase()
    );

    if (!updated) return errRes(res, 404, "Challan not found");

    return res.status(200).json({
      success: true,
      message: `Challan status updated to ${updated.status}`,
      data:    updated,
    });
  } catch (err) {
    console.error("[Challan] update-status:", err.message);
    return errRes(res, 500, err.message);
  }
});

export default router;