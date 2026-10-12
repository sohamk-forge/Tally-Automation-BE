import express from "express";
import { BANK_NAME_KEYWORDS } from "./voucher.js";

const router = express.Router();

/*
  GET /api/banks — bank names for the Banking upload dropdown.

  Served from BANK_NAME_KEYWORDS, the same canonical names the Excel
  statement bank check (validateBankMatchesLedger) compares against, so a
  selected name always matches what detection reports. Previously the
  dropdown came from the PDF/OCR service's /banks, which made Excel uploads
  impossible whenever that service was down. Same response shape as that
  endpoint: { status, count, banks: [{ id, name }] }.
*/
const BANKS = Object.keys(BANK_NAME_KEYWORDS).map((name, i) => ({
  id: 1001 + i,
  name,
}));

router.get("/", (req, res) => {
  res.json({ status: "success", count: BANKS.length, banks: BANKS });
});

export default router;
