import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import { getStockInHandXML } from "../services/xmlBuilder.js";

const router = express.Router();

/* ===================================================
   STOCK-IN-HAND VALUE — LIVE FROM TALLY
   GET /api/v1/stock/closing-balance?company=Nutan Dairy
=================================================== */

router.get("/closing-balance", async (req, res) => {
  try {
    const { company } = req.query;

    if (!company) {
      return res.status(400).json({
        success: false,
        message: "company query parameter is required"
      });
    }

    const xml = getStockInHandXML(company);

    const tallyResponse = await axios.post(
      "http://localhost:9000",
      xml,
      { headers: { "Content-Type": "application/xml" } }
    );

    const parsed = await xml2js.parseStringPromise(tallyResponse.data, {
      explicitArray: false,
      trim: true
    });

    const groups = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.GROUP;

    if (!groups) {
      return res.status(404).json({
        success: false,
        message: "Stock-in-Hand group not found in Tally response"
      });
    }

    const groupList = Array.isArray(groups) ? groups : [groups];

    const parseAmount = (val) => {
      if (val === undefined || val === null) return 0;
      const str = typeof val === "object" ? val._ : val;
      const n = parseFloat(String(str).trim());
      return isNaN(n) ? 0 : n;
    };

    let closingBalance = 0;
    for (const g of groupList) {
      closingBalance += parseAmount(g?.CLOSINGBALANCE);
    }

    return res.status(200).json({
      success: true,
      company,
      stock_value: Math.abs(closingBalance)
    });

  } catch (err) {
    console.error("stock-in-hand closing-balance fetch error:", err.message);
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

export default router;