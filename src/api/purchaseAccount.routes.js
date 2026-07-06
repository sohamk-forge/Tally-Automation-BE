import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import { getPurchaseGroupXML } from "../services/xmlBuilder.js";

const router = express.Router();

router.get("/closing-balance", async (req, res) => {
  try {
    const { company } = req.query;

    if (!company) {
      return res.status(400).json({
        success: false,
        message: "company query parameter is required"
      });
    }

    const xml = getPurchaseGroupXML(company);

    const tallyResponse = await axios.post(
      "http://localhost:9000",
      xml,
      {
        headers: { "Content-Type": "application/xml" },
        timeout: 60000   // ← ADDED — fails fast instead of hanging forever
      }
    );

    const parsed = await xml2js.parseStringPromise(tallyResponse.data, {
      explicitArray: false,
      trim: true
    });

    const groups = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.GROUP;

    if (!groups) {
      return res.status(404).json({
        success: false,
        message: "Purchase group not found in Tally response"
      });
    }

    const groupList = Array.isArray(groups) ? groups : [groups];

    const parseAmount = (val) => {
      if (val === undefined || val === null) return 0;
      let str = typeof val === "object" ? val._ : val;
      str = String(str).trim();
      if (str.endsWith("-")) str = "-" + str.slice(0, -1);
      const n = parseFloat(str);
      return isNaN(n) ? 0 : n;
    };

    let closingBalance = 0;
    for (const g of groupList) {
      closingBalance += Math.abs(parseAmount(g?.CLOSINGBALANCE));
    }

    return res.status(200).json({
      success: true,
      company,
      closing_balance: Number(closingBalance.toFixed(2))
    });

  } catch (err) {
    console.error("purchase closing-balance fetch error:", err.message);

    // ← ADDED — distinguish a genuine timeout from other errors
    if (err.code === "ECONNABORTED") {
      return res.status(504).json({
        success: false,
        message: `Tally did not respond within 30s. Check that "${req.query.company}" is currently open in Tally and the name matches exactly.`
      });
    }

    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

export default router;