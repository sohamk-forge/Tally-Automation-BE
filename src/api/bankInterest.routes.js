import express from "express";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

/* ===================================================
   BANK INTEREST SUMMARY API

   For each bank/OD ledger belonging to the company, scans
   the vouchers already synced from Tally for interest-flavored
   entries (Payment/Journal vouchers whose narration or ledger
   entries mention "interest"), sums them per month, and combines
   with the ledger's OD limit (now persisted from Tally's ODLIMIT
   field) to show utilization.

   Approximation: this business does not use Tally's built-in
   "Activate Interest Calculation" ledger feature (confirmed via a
   direct Tally XML test — no interest-rate fields exist on these
   ledgers), so there is no ledger-level rate to read. Interest is
   only visible as ordinary vouchers your accountant books from the
   bank statement (e.g. narration "Int.Coll:02-07-2026 to
   02-08-2026"). This endpoint is therefore a voucher-scan, not a
   read of a Tally-computed rate.

   GET /api/bank-interest-summary
   ?company_id=1
   &fromDate=2025-04-01
   &toDate=2026-03-31
=================================================== */

router.get("/bank-interest-summary", async (req, res) => {
  try {
    const companyId = req.query.company_id;
    const fromDate = req.query.fromDate;
    const toDate = req.query.toDate;

    if (!companyId || !fromDate || !toDate) {
      return res.status(400).json({
        status: "error",
        message: "company_id, fromDate and toDate required"
      });
    }

    const banksResult = await pool.query(
      `
      SELECT ledger_name, parent_group, closing_balance, od_limit
      FROM ${DB_SCHEMA}.bank_accounts
      WHERE company_id = $1
      ORDER BY ledger_name
      `,
      [companyId]
    );

    const banks = banksResult.rows;
    if (banks.length === 0) {
      return res.status(200).json({ status: "success", company_id: companyId, data: [] });
    }

    const data = [];

    for (const bank of banks) {
      const voucherResult = await pool.query(
        `
        SELECT id, voucher_date, voucher_type, voucher_number, narration,
               debit_amount, credit_amount
        FROM ${DB_SCHEMA}.vouchers
        WHERE company_id = $1
          AND DATE(voucher_date) BETWEEN $2 AND $3
          AND (
            LOWER(party_ledger_name) = LOWER($4)
            OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(ledger_entries) e
              WHERE LOWER(e->>'LEDGERNAME') = LOWER($4)
            )
          )
          AND (
            LOWER(narration) LIKE '%interest%'
            OR LOWER(narration) LIKE '%int.coll%'
            OR LOWER(narration) LIKE '%o/d int%'
          )
          AND deleted_at IS NULL
        ORDER BY voucher_date
        `,
        [companyId, fromDate, toDate, bank.ledger_name]
      );

      const vouchers = voucherResult.rows;
      const totalInterest = vouchers.reduce(
        (sum, v) => sum + Number(v.debit_amount || 0) + Number(v.credit_amount || 0),
        0
      );

      const monthly = {};
      for (const v of vouchers) {
        const monthKey = new Date(v.voucher_date).toISOString().slice(0, 7); // YYYY-MM
        const amount = Number(v.debit_amount || 0) + Number(v.credit_amount || 0);
        monthly[monthKey] = (monthly[monthKey] || 0) + amount;
      }

      const odLimit = Number(bank.od_limit || 0);
      const closingBalance = Number(bank.closing_balance || 0);
      const utilizationPct = odLimit > 0
        ? Number(((Math.abs(closingBalance) / odLimit) * 100).toFixed(2))
        : null;

      data.push({
        ledger_name: bank.ledger_name,
        parent_group: bank.parent_group,
        od_limit: odLimit || null,
        closing_balance: closingBalance,
        utilization_pct: utilizationPct,
        total_interest_paid: Number(totalInterest.toFixed(2)),
        voucher_count: vouchers.length,
        monthly_breakdown: Object.entries(monthly)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([month, amount]) => ({ month, amount: Number(amount.toFixed(2)) })),
        vouchers: vouchers.map(v => ({
          id: v.id,
          voucher_date: v.voucher_date,
          voucher_type: v.voucher_type,
          voucher_number: v.voucher_number,
          narration: v.narration,
          amount: Number(v.debit_amount || 0) + Number(v.credit_amount || 0)
        }))
      });
    }

    return res.status(200).json({
      status: "success",
      company_id: companyId,
      fromDate,
      toDate,
      data
    });
  } catch (err) {
    console.log("❌ BANK INTEREST SUMMARY ERROR:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

export default router;
