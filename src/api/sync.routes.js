import express from "express";
import axios from "axios";
import { TALLY_URL } from "../config/env.js";

const router = express.Router();

router.get("/health", async (req, res) => {
  try {
    await axios.get(TALLY_URL);

    res.json({
      status: "success",
      message: "Tally server reachable",
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      message: "Tally not reachable",
    });
  }
});

export default router;