import express from "express";
import { sendToTally } from "../services/tallyClient.js";
import { getCompaniesXML } from "../services/xmlBuilder.js";
import { parseXML } from "../services/parser.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const xml = getCompaniesXML();
    const responseXML = await sendToTally(xml);
    const result = parseXML(responseXML);

    const company =
      result?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY;

    res.json({
      status: "success",
      message: "Companies fetched successfully",
      data: [
        {
          name: company.NAME
        }
      ]
    });

  } catch (err) {
    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;