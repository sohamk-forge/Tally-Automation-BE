import express from "express";
import { getHybridBalance } from "../services/tallyHybrid.service.js";
import { getPurchaseGroupXML } from "../services/xmlBuilder.js";

const router = express.Router();

router.get("/closing-balance", async (req, res) => {
  try {
    const { company } = req.query;

    const result = await getHybridBalance({
      company,
      type: "purchase",
      cacheKey: `purchase:${company}`,
      xmlBuilder: getPurchaseGroupXML,
      transform: (v) => Math.abs(v)
    });

    return res.json({
      success: true,
      company,
      closing_balance: result.value,
      source: result.source
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

export default router;