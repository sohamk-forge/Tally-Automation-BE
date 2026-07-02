import express from "express";
import { getHybridBalance } from "../services/tallyHybrid.service.js";
import { getSalesGroupXML } from "../services/xmlBuilder.js";

const router = express.Router();

router.get("/closing-balance", async (req, res) => {
  try {
    const { company } = req.query;

    if (!company) {
      return res.status(400).json({
        success: false,
        message: "company required"
      });
    }

    const result = await getHybridBalance({
      company,
      type: "sales",
      cacheKey: `sales:${company}`,
      xmlBuilder: getSalesGroupXML
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