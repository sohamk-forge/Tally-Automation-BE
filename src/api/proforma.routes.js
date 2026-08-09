// src/api/proforma.routes.js
import { Router } from "express";
import {
  getAllProformaInvoices,
  getProformaInvoiceById,
  peekNextProformaNumber,
  updateProformaStatus,
} from "../services/proforma.service.js";

const router = Router();

router.get("/next-number", async (req, res) => {
  try {
    const companyId = req.query.companyId || req.headers["x-company-id"];
    if (!companyId) {
      return res.status(400).json({ success: false, message: "companyId is required" });
    }
    const result = await peekNextProformaNumber(companyId);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error("GET /proforma/next-number error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch next proforma number" });
  }
});

router.get("/", async (req, res) => {
  try {
    const companyId = req.query.companyId || req.headers["x-company-id"];
    if (!companyId) {
      return res.status(400).json({ success: false, message: "companyId is required" });
    }
    const { status, customer_name } = req.query;
    const rows = await getAllProformaInvoices(companyId, { status, customer_name });
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("GET /proforma error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch proforma invoices" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const companyId = req.query.companyId || req.headers["x-company-id"];
    if (!companyId) {
      return res.status(400).json({ success: false, message: "companyId is required" });
    }
    const proforma = await getProformaInvoiceById(req.params.id, companyId);
    if (!proforma) {
      return res.status(404).json({ success: false, message: "Proforma invoice not found" });
    }
    res.json({ success: true, data: proforma });
  } catch (err) {
    console.error("GET /proforma/:id error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch proforma invoice" });
  }
});

router.patch("/:id/status", async (req, res) => {
  try {
    const companyId = req.body.companyId || req.headers["x-company-id"];
    if (!companyId) {
      return res.status(400).json({ success: false, message: "companyId is required" });
    }
    const updated = await updateProformaStatus(req.params.id, companyId, req.body.status);
    if (!updated) {
      return res.status(404).json({ success: false, message: "Proforma invoice not found" });
    }
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error("PATCH /proforma/:id/status error:", err);
    const status = /Invalid status/i.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, message: err.message || "Failed to update status" });
  }
});

export default router;