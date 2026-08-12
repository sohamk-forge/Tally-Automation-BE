/**
 * src/services/delivery-person.service.js
 *
 * Backs the "Select Delivery Person" dropdown on the challan form.
 * Delivery persons are scoped to a company and are created inline
 * ("+ Create new Delivery person") from the frontend, so a plain
 * name + optional phone number is all that's required.
 */

import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: listDeliveryPersons
// ─────────────────────────────────────────────────────────────────────────────

export async function listDeliveryPersons(companyId) {
  const res = await pool.query(
    `SELECT id, name, phone_number, created_at
     FROM ${DB_SCHEMA}.delivery_persons
     WHERE company_id = $1
     ORDER BY name ASC`,
    [companyId]
  );
  return res.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: createDeliveryPerson
// ─────────────────────────────────────────────────────────────────────────────

export async function createDeliveryPerson(companyId, { name, phone_number }) {
  const cleanName  = String(name || "").trim();
  const cleanPhone = phone_number ? String(phone_number).trim() : null;

  if (!cleanName) throw new Error("Delivery person name is required");

  const res = await pool.query(
    `INSERT INTO ${DB_SCHEMA}.delivery_persons (company_id, name, phone_number)
     VALUES ($1, $2, $3)
     RETURNING id, name, phone_number, created_at`,
    [companyId, cleanName, cleanPhone]
  );

  return res.rows[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: getDeliveryPersonById
// Used by GET /api/v1/delivery-person/:id, and internally by
// challan.service.js to validate delivery_person_id belongs to the same
// company before attaching it to a challan.
// ─────────────────────────────────────────────────────────────────────────────

export async function getDeliveryPersonById(companyId, deliveryPersonId) {
  if (!deliveryPersonId) return null;

  const res = await pool.query(
    `SELECT id, name, phone_number, created_at
     FROM ${DB_SCHEMA}.delivery_persons
     WHERE id = $1 AND company_id = $2`,
    [deliveryPersonId, companyId]
  );

  return res.rows[0] || null;
}