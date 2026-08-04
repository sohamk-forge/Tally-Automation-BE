/**
 * src/api/challanpdf.routes.js
 *
 * Standalone router — mount it separately from challan.routes.js:
 *
 *   import challanPdfRoutes from "./api/challanpdf.routes.js";
 *   app.use("/api/v1/challan", ...requireSessionOrApiKey(), challanPdfRoutes);
 *
 * (Mounted on the same "/api/v1/challan" prefix as challan.routes.js —
 * Express is fine with two routers sharing a prefix as long as the
 * sub-paths don't collide, and ":id/pdf" doesn't collide with anything
 * in challan.routes.js.)
 */

import express from "express";
import { getChallanById } from "../services/challan.service.js";
import { buildChallanPdf } from "../services/challan-pdf.service.js";

const router = express.Router();

function errRes(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/challan/:id/pdf?company_id=1
//
// Streams a printable PDF of the challan. Same auth/data path as the
// existing "get" action — company_id is required so a challan can't be
// downloaded across companies.
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id/pdf", async (req, res) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return errRes(res, 400, "company_id is required");

    const challanId = Number(req.params.id);
    if (!Number.isInteger(challanId)) {
      // Catches "undefined", "", non-numeric ids, etc. before they ever
      // reach the DB query or Puppeteer. This is almost always caused by
      // the frontend calling this endpoint for a row that has no real
      // challan id — e.g. a Sales/voucher row mistaken for a Challan row
      // in a merged transactions table. Returns a clean 400 with the bad
      // value included, instead of a raw, unexplained 500.
      return errRes(res, 400, `Invalid challan id: "${req.params.id}"`);
    }

    const challan = await getChallanById(challanId, Number(company_id));
    if (!challan) return errRes(res, 404, "Challan not found");

    const pdfBytes = await buildChallanPdf(challan);

    res.setHeader("Content-Type", "application/pdf");
    // inline = opens in browser tab; swap to attachment; ... to force download
    res.setHeader(
      "Content-Disposition",
      `inline; filename="Challan-${challan.challan_number || challan.id}.pdf"`
    );
    return res.status(200).send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error("[Challan] pdf:", err.message);
    return errRes(res, 500, err.message);
  }
});

export default router;