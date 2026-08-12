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
 *   GET  /api/v1/challan/next-number?company_id=1
 *        → READ-ONLY preview of what the next challan number will be.
 *          Call this when the create-challan form loads. Does not create
 *          anything or touch the counter. Safe to call repeatedly.
 *
 *   POST /api/v1/challan   { action: "create", ... }
 *        → Actually creates the challan and atomically claims the number.
 *
 *   POST /api/v1/challan   { action: "update", ... }
 *        → Updates an existing challan's header + replaces its line items.
 *          challan_number/seq are never changed.
 *
 *   POST /api/v1/challan   { action: "list", ... }
 *        → Returns all challans for a company (with optional filters).
 *
 *   POST /api/v1/challan   { action: "get", ... }
 *        → Returns a single challan (with items) by challan_id.
 *
 *   POST /api/v1/challan   { action: "update_status", ... }
 *        → Updates status of a challan (DRAFT / CONFIRMED / CANCELLED).
 *
 *   GET  /api/v1/challan/all?company_id=1
 *        → Plain GET list view, same data as action:"list".
 *
 *   GET  /api/v1/challan/:id?company_id=1
 *        → Plain GET detail view, same data as action:"get".
 *
 * ─────────────────────────────────────────────
 * NOTE ON DELIVERY PERSONS
 * ─────────────────────────────────────────────
 * "Select Delivery Person" on the frontend is backed by a separate
 * resource — see delivery-person.routes.js:
 *   GET  /api/v1/delivery-person?company_id=1        (list, for the dropdown)
 *   POST /api/v1/delivery-person                      (the "+ Create new
 *                                                        Delivery person" form)
 * Once created there, pass its numeric id back here as delivery_person_id.
 */

import express from "express";
import {
  createChallan,
  updateChallan,
  getAllChallans,
  getChallanById,
  updateChallanStatus,
  peekNextChallanNumber,
} from "../services/challan.service.js";

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function ok(res, status, payload) {
  return res.status(status).json({ success: true, ...payload });
}

function errRes(res, status, message, details) {
  return res.status(status).json({
    success: false,
    error:   message,
    ...(details ? { details } : {}),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/challan/next-number?company_id=1
//
// Dedicated, separate API — purely for the frontend to display the upcoming
// challan number BEFORE the user saves. No side effects.
// ─────────────────────────────────────────────────────────────────────────────

router.get("/next-number", async (req, res) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return errRes(res, 400, "company_id is required");

    const preview = await peekNextChallanNumber(Number(company_id));
    return ok(res, 200, { data: preview });
  } catch (err) {
    console.error("[Challan] next-number:", err.message);
    return errRes(res, 500, err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// action = "create"
//
// Body:
// {
//   "action": "create",
//   "company_id":       1,
//   "company_name":     "Sai Computech",
//   "challan_date":     "2026-07-01",
//   "customer_name":    "ABC Traders",
//   "customer_gstin":   "27AABCE9378F5ZG",     ← optional
//   "customer_address": "Mumbai",               ← optional
//   "narration":        "Goods delivered",      ← optional
//   "supply_type":      "intrastate",           ← "intrastate" | "interstate"
//   "challan_type":      "Return Replacement",  ← optional, defaults to
//                                                  "Delivery Challan"
//   "movement_type":     "outward",             ← optional, "inward" | "outward"
//   "delivery_person_id": 3,                    ← optional, id from
//                                                  GET /api/v1/delivery-person
//   "items": [
//     {
//       "item_name":         "Item A",
//       "godown_name":       "Main Store",      ← optional
//       "hsn_code":          "8471",            ← optional
//       "qty":               10,
//       "rate":              500,
//       "gst_rate":          "18%",
//       "discount_percent":  5,                 ← optional, default 0
//       "sort_order":        0                  ← optional
//     }
//   ]
// }
//
// Note: challan_number is NEVER sent by the frontend — it's always
// auto-allocated by the backend inside this call.
// ─────────────────────────────────────────────────────────────────────────────

async function handleCreate(req, res) {
  const {
    company_id, company_name,
    challan_date, customer_name, customer_gstin, customer_address,
    narration, supply_type, challan_type, movement_type, delivery_person_id,
    items,
  } = req.body;

  if (!company_id)   return errRes(res, 400, "company_id is required");
  if (!challan_date) return errRes(res, 400, "challan_date is required");
  if (!Array.isArray(items) || items.length === 0) {
    return errRes(res, 400, "items[] array with at least one item is required");
  }

  try {
    const challan = await createChallan({
      company_id: Number(company_id),
      company_name,
      challan_date,
      customer_name,
      customer_gstin,
      customer_address,
      narration,
      supply_type,
      challan_type,
      movement_type,
      delivery_person_id,
      items,
    });

    return ok(res, 201, {
      message: `Challan ${challan.challan_number} created successfully`,
      data:    challan,
    });
  } catch (err) {
    console.error("[Challan] create:", err.message);
    return errRes(res, 500, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// action = "update"
//
// Body:
// {
//   "action": "update",
//   "company_id":  1,
//   "challan_id":  42,          ← the numeric id, not the challan_number
//   "challan_date": "2026-07-01",
//   "customer_name": "ABC Traders",
//   ...same editable fields as create, minus challan_number...
//   "challan_type":      "Return Replacement",
//   "movement_type":     "outward",
//   "delivery_person_id": 3,
//   "items": [ ... ]
// }
//
// challan_number/seq are never changed by this action.
// ─────────────────────────────────────────────────────────────────────────────

async function handleUpdate(req, res) {
  const {
    company_id, challan_id,
    challan_date, customer_name, customer_gstin, customer_address,
    narration, supply_type, challan_type, movement_type, delivery_person_id,
    items,
  } = req.body;

  if (!company_id)   return errRes(res, 400, "company_id is required");
  if (!challan_id)   return errRes(res, 400, "challan_id is required");
  if (!challan_date) return errRes(res, 400, "challan_date is required");
  if (!Array.isArray(items) || items.length === 0) {
    return errRes(res, 400, "items[] array with at least one item is required");
  }

  try {
    const challan = await updateChallan(Number(challan_id), Number(company_id), {
      challan_date,
      customer_name,
      customer_gstin,
      customer_address,
      narration,
      supply_type,
      challan_type,
      movement_type,
      delivery_person_id,
      items,
    });

    if (!challan) return errRes(res, 404, "Challan not found");

    return ok(res, 200, {
      message: `Challan ${challan.challan_number} updated successfully`,
      data:    challan,
    });
  } catch (err) {
    console.error("[Challan] update:", err.message);
    return errRes(res, 500, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// action = "list"
// ─────────────────────────────────────────────────────────────────────────────

async function handleList(req, res) {
  const { company_id, status, from_date, to_date, customer_name } = req.body;

  if (!company_id) return errRes(res, 400, "company_id is required");

  try {
    const challans = await getAllChallans(Number(company_id), {
      status,
      from_date,
      to_date,
      customer_name,
    });

    return ok(res, 200, { count: challans.length, data: challans });
  } catch (err) {
    console.error("[Challan] list:", err.message);
    return errRes(res, 500, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// action = "get"
// ─────────────────────────────────────────────────────────────────────────────

async function handleGet(req, res) {
  const { company_id, challan_id } = req.body;

  if (!company_id)  return errRes(res, 400, "company_id is required");
  if (!challan_id)  return errRes(res, 400, "challan_id is required");

  try {
    const challan = await getChallanById(Number(challan_id), Number(company_id));
    if (!challan) return errRes(res, 404, "Challan not found");

    return ok(res, 200, { data: challan });
  } catch (err) {
    console.error("[Challan] get:", err.message);
    return errRes(res, 500, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// action = "update_status"
// ─────────────────────────────────────────────────────────────────────────────

async function handleUpdateStatus(req, res) {
  const { company_id, challan_id, status } = req.body;

  if (!company_id) return errRes(res, 400, "company_id is required");
  if (!challan_id) return errRes(res, 400, "challan_id is required");
  if (!status)     return errRes(res, 400, "status is required");

  try {
    const updated = await updateChallanStatus(
      Number(challan_id),
      Number(company_id),
      String(status).toUpperCase()
    );

    if (!updated) return errRes(res, 404, "Challan not found");

    return ok(res, 200, {
      message: `Challan status updated to ${updated.status}`,
      data:    updated,
    });
  } catch (err) {
    console.error("[Challan] update_status:", err.message);
    return errRes(res, 500, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE ENTRY POINT — POST /api/v1/challan
// ─────────────────────────────────────────────────────────────────────────────

router.post("/", async (req, res) => {
  const { action } = req.body;

  switch (action) {
    case "create":
      return handleCreate(req, res);
    case "update":
      return handleUpdate(req, res);
    case "list":
      return handleList(req, res);
    case "get":
      return handleGet(req, res);
    case "update_status":
      return handleUpdateStatus(req, res);
    default:
      return errRes(
        res, 400,
        `Invalid or missing "action". Must be one of: "create", "update", "list", "get", "update_status".`
      );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/challan/all?company_id=1
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

    return ok(res, 200, { count: challans.length, data: challans });
  } catch (err) {
    console.error("[Challan] GET all:", err.message);
    return errRes(res, 500, err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/challan/:id?company_id=1
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id", async (req, res) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return errRes(res, 400, "company_id is required");

    const challan = await getChallanById(Number(req.params.id), Number(company_id));
    if (!challan) return errRes(res, 404, "Challan not found");

    return ok(res, 200, { data: challan });
  } catch (err) {
    console.error("[Challan] GET by id:", err.message);
    return errRes(res, 500, err.message);
  }
});

export default router;