import express from "express";
import pool from "../db/index.js";
import axios from "axios";
import multer from "multer";
import FormData from "form-data";
import fs from "fs";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

const upload = multer({
  dest: "uploads/"
});

/*
=========================================
NORMALIZE ITEM NAME
=========================================
*/
function normalizeItemName(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ");
}

/*
=========================================
SHARED VALIDATION LOGIC
Used by both /validate and /upload

Buckets:
  - missing_items  -> item is NOT in the DB at all (not available in DB)
  - not_available  -> item IS in the DB, but current stock quantity is 0
  - quantity_less  -> item IS in the DB with some stock, but less than required
  - matched_items  -> item IS in the DB with enough stock to cover what's required
=========================================
*/
async function validateItemsAgainstStock(company, extracted_items) {

  if (!company) {
    return {
      httpStatus: 400,
      body: { status: "error", message: "company is required" }
    };
  }

  if (!Array.isArray(extracted_items) || extracted_items.length === 0) {
    return {
      httpStatus: 400,
      body: { status: "error", message: "extracted_items is required" }
    };
  }

  // Find company
  const companyResult = await pool.query(
    `
    SELECT id
    FROM ${DB_SCHEMA}.companies
    WHERE TRIM(name) = TRIM($1)
    `,
    [company]
  );

  const companyId = companyResult.rows[0]?.id;

  if (!companyId) {
    return {
      httpStatus: 400,
      body: { status: "error", message: "Company not found" }
    };
  }

  // Fetch stock items
  const stockResult = await pool.query(
    `
    SELECT
      item_name,
      quantity,
      group_name,
      hsn_code
    FROM ${DB_SCHEMA}.stock_group_summary
    WHERE company_id = $1
    `,
    [companyId]
  );

  const stockItems = stockResult.rows;

  const matched_items = [];
  const quantity_less = [];
  const not_available = [];
  const missing_items = [];

  for (const extractedItem of extracted_items) {

    const normalizedPdfItem = normalizeItemName(extractedItem.item_name);

    const dbItem = stockItems.find(
      item => normalizeItemName(item.item_name) === normalizedPdfItem
    );

    if (!dbItem) {
      missing_items.push({
        item_name: extractedItem.item_name,
        required_quantity: Number(extractedItem.quantity)
      });
      continue;
    }

    const availableQuantity = Number(dbItem.quantity);
    const requiredQuantity = Number(extractedItem.quantity);

    if (availableQuantity === 0) {

      not_available.push({
        item_name: dbItem.item_name,
        required_quantity: requiredQuantity,
        available_quantity: availableQuantity,
        group_name: dbItem.group_name,
        hsn_code: dbItem.hsn_code
      });

    } else if (availableQuantity < requiredQuantity) {

      quantity_less.push({
        item_name: dbItem.item_name,
        required_quantity: requiredQuantity,
        available_quantity: availableQuantity,
        short_by: requiredQuantity - availableQuantity,
        group_name: dbItem.group_name,
        hsn_code: dbItem.hsn_code
      });

    } else {

      matched_items.push({
        item_name: dbItem.item_name,
        required_quantity: requiredQuantity,
        available_quantity: availableQuantity,
        group_name: dbItem.group_name,
        hsn_code: dbItem.hsn_code
      });

    }
  }

  return {
    httpStatus: 200,
    body: {
      status: "success",
      summary: {
        total_extracted_items: extracted_items.length,
        matched: matched_items.length,
        quantity_less: quantity_less.length,
        not_available: not_available.length,
        missing_items: missing_items.length
      },
      validation: {
        matched_items,
        quantity_less,
        not_available,
        missing_items
      }
    }
  };
}

/*
=========================================
POST /upload
Receives PDF, sends to OCR service,
converts items, and validates against stock
=========================================
*/
router.post(
  "/upload",
  upload.single("file"),
  async (req, res) => {

    let tempFilePath = null;

    try {
      const { company } = req.body;

      if (!company) {
        return res.status(400).json({
          status: "error",
          message: "company is required"
        });
      }

      if (!req.file) {
        return res.status(400).json({
          status: "error",
          message: "PDF file is required"
        });
      }

      tempFilePath = req.file.path;

      // Send PDF to OCR service
      const form = new FormData();
      form.append(
        "file",
        fs.createReadStream(tempFilePath),
        req.file.originalname
      );

      const ocrResponse = await axios.post(
        "http://100.75.147.11:8000/extract-items",
        form,
        { headers: form.getHeaders() }
      );

      const ocrData = ocrResponse.data;

      if (!ocrData || !Array.isArray(ocrData.items)) {
        return res.status(502).json({
          status: "error",
          message: "OCR service returned an unexpected response",
          ocr_response: ocrData
        });
      }

      // Convert OCR items -> validation format
      const extracted_items = ocrData.items.map(item => ({
        item_name: item.description,
        quantity: Number(item.quantity)
      }));

      // Run shared validation logic
      const result = await validateItemsAgainstStock(company, extracted_items);

      return res.status(result.httpStatus).json({
        ...result.body,
        ocr_response: ocrData
      });

    } catch (error) {

      console.error("Upload/OCR Error:", error.response?.data || error.message);

      return res.status(500).json({
        status: "error",
        message: error.message
      });

    } finally {
      // Clean up temp uploaded file
      if (tempFilePath) {
        fs.unlink(tempFilePath, (err) => {
          if (err) console.error("Failed to delete temp file:", err);
        });
      }
    }
  }
);

/*
=========================================
POST /validate
Direct validation (unchanged behavior)
=========================================
*/
router.post("/validate", async (req, res) => {
  try {
    const { company, extracted_items } = req.body;

    const result = await validateItemsAgainstStock(company, extracted_items);

    return res.status(result.httpStatus).json(result.body);

  } catch (error) {

    console.error("Validation Error:", error);

    return res.status(500).json({
      status: "error",
      message: error.message
    });

  }
});

export default router;