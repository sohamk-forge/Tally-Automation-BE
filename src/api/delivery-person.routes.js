/**
 * src/api/delivery-person.routes.js
 *
 * Register in app.js:
 *   import deliveryPersonRoutes from "./api/delivery-person.routes.js";
 *   app.use("/api/v1/delivery-person", deliveryPersonRoutes);
 *
 * ─────────────────────────────────────────────
 * ENDPOINTS
 * ─────────────────────────────────────────────
 *
 *   GET  /api/v1/delivery-person?company_id=1
 *        → Returns saved delivery persons for the company, for the
 *          "Select Delivery Person" dropdown.
 *
 *   POST /api/v1/delivery-person   { company_id, name, phone_number }
 *        → Creates a delivery person. Call this from the "+ Create new
 *          Delivery person" inline form, then refresh/prepend the
 *          dropdown with the returned record instead of only holding
 *          it in local state.
 *
 *   GET  /api/v1/delivery-person/:id?company_id=1
 *        → Returns a single delivery person by id.
 */

import express from "express";
import {
  listDeliveryPersons,
  createDeliveryPerson,
  getDeliveryPersonById,
} from "../services/delivery-person.service.js";

const router = express.Router();

function ok(res, status, payload) {
  return res.status(status).json({ success: true, ...payload });
}

function errRes(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/delivery-person?company_id=1
// ─────────────────────────────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return errRes(res, 400, "company_id is required");

    const persons = await listDeliveryPersons(Number(company_id));
    return ok(res, 200, { count: persons.length, data: persons });
  } catch (err) {
    console.error("[DeliveryPerson] list:", err.message);
    return errRes(res, 500, err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/delivery-person
// ─────────────────────────────────────────────────────────────────────────────

router.post("/", async (req, res) => {
  try {
    const { company_id, name, phone_number } = req.body;
    if (!company_id) return errRes(res, 400, "company_id is required");
    if (!name)        return errRes(res, 400, "name is required");

    const person = await createDeliveryPerson(Number(company_id), {
      name,
      phone_number,
    });

    return ok(res, 201, {
      message: `Delivery person "${person.name}" created`,
      data:    person,
    });
  } catch (err) {
    console.error("[DeliveryPerson] create:", err.message);
    return errRes(res, 500, err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/delivery-person/:id?company_id=1
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id", async (req, res) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return errRes(res, 400, "company_id is required");

    const person = await getDeliveryPersonById(Number(company_id), Number(req.params.id));
    if (!person) return errRes(res, 404, "Delivery person not found");

    return ok(res, 200, { data: person });
  } catch (err) {
    console.error("[DeliveryPerson] get:", err.message);
    return errRes(res, 500, err.message);
  }
});

export default router;