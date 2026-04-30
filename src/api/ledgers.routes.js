import express from "express";
import { sendToTally } from "../services/tallyClient.js";
import { getLedgersXML } from "../services/xmlBuilder.js";
import { parseXML } from "../services/parser.js";

const router = express.Router();

// GET /api/sync/ledgers
router.get("/", async (req, res) => {
  try {
    const company = req.query.company;

    if (!company) {
      return res.status(400).json({
        status: "error",
        message: "Company query parameter is required",
      });
    }

    // 1. Fetch from Tally
    const xml = getLedgersXML(company);
    const responseXML = await sendToTally(xml);

    if (!responseXML || !responseXML.includes("<ENVELOPE>")) {
      return res.status(500).json({
        status: "error",
        message: "Invalid response from Tally",
      });
    }

    // 2. Parse XML
    const parsed = parseXML(responseXML);

    const collection =
      parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION ||
      parsed?.ENVELOPE?.BODY?.DATA;

    // 3. Extract ledgers
    const ledgers = [];

    function extract(obj) {
      if (!obj) return;

      if (Array.isArray(obj)) {
        obj.forEach(extract);
        return;
      }

      if (typeof obj === "object") {
        if (obj.NAME) {
          const cleanName = String(obj.NAME)
            .replace(/&#13;&#10;|\r|\n/g, "")
            .trim();

          ledgers.push({
            ledger_name: cleanName,
            parent_group: obj.PARENT || null,
          });
        }

        for (const key in obj) {
          extract(obj[key]);
        }
      }
    }

    extract(collection);

    res.json({
      status: "success",
      message: "Ledgers fetched successfully",
      count: ledgers.length,
      data: ledgers,
    });

  } catch (err) {
    console.error("Ledger Sync Error:", err);

    res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

export default router;