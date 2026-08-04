// src/api/quotation.routes.js
import { Router } from "express";
import {
  getAllQuotations,
  getQuotationById,
  createQuotation,
  peekNextQuotationNumber,
  updateQuotationStatus,
} from "../services/quotation.service.js";

const router = Router();

router.get("/next-number", async (req, res) => {
  try {
    const companyId = req.query.companyId || req.headers["x-company-id"];
    if (!companyId) {
      return res.status(400).json({ success: false, message: "companyId is required" });
    }
    const result = await peekNextQuotationNumber(companyId);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error("GET /quotation/next-number error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch next quotation number" });
  }
});

router.get("/", async (req, res) => {
  try {
    const companyId = req.query.companyId || req.headers["x-company-id"];
    if (!companyId) {
      return res.status(400).json({ success: false, message: "companyId is required" });
    }
    const { status, from_date, to_date, customer_name } = req.query;
    const rows = await getAllQuotations(companyId, { status, from_date, to_date, customer_name });
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("GET /quotation error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch quotations" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const companyId = req.query.companyId || req.headers["x-company-id"];
    if (!companyId) {
      return res.status(400).json({ success: false, message: "companyId is required" });
    }
    const quotation = await getQuotationById(req.params.id, companyId);
    if (!quotation) {
      return res.status(404).json({ success: false, message: "Quotation not found" });
    }
    res.json({ success: true, data: quotation });
  } catch (err) {
    console.error("GET /quotation/:id error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch quotation" });
  }
});

router.post("/", async (req, res) => {
  try {
    const quotation = await createQuotation(req.body);
    res.status(201).json({ success: true, data: quotation });
  } catch (err) {
    console.error("POST /quotation error:", err);
    const status = /required/i.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, message: err.message || "Failed to create quotation" });
  }
});

router.patch("/:id/status", async (req, res) => {
  try {
    const companyId = req.body.companyId || req.headers["x-company-id"];
    if (!companyId) {
      return res.status(400).json({ success: false, message: "companyId is required" });
    }
    const updated = await updateQuotationStatus(req.params.id, companyId, req.body.status);
    if (!updated) {
      return res.status(404).json({ success: false, message: "Quotation not found" });
    }
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error("PATCH /quotation/:id/status error:", err);
    const status = /Invalid status/i.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, message: err.message || "Failed to update status" });
  }
});

export default router;