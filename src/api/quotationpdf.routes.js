// src/api/quotationpdf.routes.js
import { Router } from "express";
import { getQuotationById } from "../services/quotation.service.js";
import { generateQuotationPdf } from "../services/quotation-pdf.service.js";

const router = Router();

router.get("/:id/pdf", async (req, res) => {
  try {
    const companyId = req.query.companyId || req.headers["x-company-id"];
    if (!companyId) {
      return res.status(400).json({ success: false, message: "companyId is required" });
    }

    const quotation = await getQuotationById(req.params.id, companyId);
    if (!quotation) {
      return res.status(404).json({ success: false, message: "Quotation not found" });
    }

    const pdfBuffer = await generateQuotationPdf(quotation);

    res.status(200);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="Quotation-${quotation.quotation_number}.pdf"`,
      "Content-Length": pdfBuffer.length,
    });

    // IMPORTANT: use res.end(), not res.send().
    // The global loggerMiddleware overrides res.send/res.json and tries
    // to JSON-serialize the response body for an audit log insert. For a
    // Buffer (this PDF) that blows the payload up massively and blocks
    // the response on a DB write. res.end() is never overridden, so it
    // skips that logic entirely and writes the raw bytes immediately.
    res.end(pdfBuffer);
  } catch (err) {
    console.error("GET /quotation/:id/pdf error:", err);
    // This error path DOES go through res.status().json(), which still
    // hits the buggy middleware — but the body there is a small plain
    // object, so it's slow/double-logged, not corrupted.
    res.status(500).json({ success: false, message: "Failed to generate PDF" });
  }
});

export default router;