import express from "express";
import { sendToTally } from "../services/tallyClient.js";
import { getLedgersXML } from "../services/xmlBuilder.js";
import { parseXML } from "../services/parser.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const company = req.query.company || "";

    const xml = getLedgersXML(company);
    const responseXML = await sendToTally(xml);
    const data = parseXML(responseXML);

    res.json({
      status: "success",
      message: "Ledgers fetched successfully",
      data
    });

  } catch (err) {
    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;