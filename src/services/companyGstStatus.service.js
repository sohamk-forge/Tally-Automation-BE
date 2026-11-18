// src/services/companyGstStatus.service.js
//
// A company is non-GST when Tally's company details carry no GSTIN.
// The GSTIN is imported from Tally into company_details by the company sync.
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";

export async function isNonGstCompany(companyId) {
  const { rows } = await pool.query(
    `SELECT gstin FROM ${DB_SCHEMA}.company_details WHERE company_id = $1 LIMIT 1`,
    [companyId]
  );
  return !String(rows[0]?.gstin || "").trim();
}
