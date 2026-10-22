import express from "express";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

/* ===================================================
   CASH IN HAND & BANK BALANCE (dashboard cards)
===================================================

GET /api/v1/cash-bank-balance?company_id=1

Source: bank_accounts — the ledger sync pulls every ledger that belongs to
Cash-in-Hand, Bank Accounts, Bank OD A/c and Bank OCC A/c into it (see
xmlBuilder.js, $$IsBelongsTo), with the ledger's immediate parent group.

Balances are returned Dr-POSITIVE (money you hold): Tally stores Dr as a
negative closing balance, so balance = -closing_balance.
  cash.balance  > 0 → cash in hand (Dr); < 0 → cash in credit (data issue)
  bank.balance  > 0 → net funds at bank; < 0 → net overdrawn (OD/OCC in use)

=================================================== */

// Immediate parent of a ledger under Cash-in-Hand. A user sub-group under
// Cash-in-Hand (e.g. "Petty Cash") is caught by the name match.
const isCashGroup = (group) =>
  group === "Cash-in-Hand" || /cash/i.test(group || "");

const isOdGroup = (group) => /\bod\b|\bocc\b|overdraft/i.test(group || "");

const round2 = (n) => Number((Number(n) || 0).toFixed(2));

router.get("/cash-bank-balance", async (req, res) => {
  try {
    const companyId = Number(req.query.company_id);

    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({
        status: "error",
        message: "Valid company_id query parameter required",
      });
    }

    const result = await pool.query(
      `SELECT ledger_name, parent_group, closing_balance, od_limit, updated_at
       FROM ${DB_SCHEMA}.bank_accounts
       WHERE company_id = $1
       ORDER BY ledger_name ASC`,
      [companyId]
    );

    const cash = { balance: 0, ledger_count: 0, ledgers: [] };
    const bank = { balance: 0, ledger_count: 0, od_utilised: 0, od_limit: 0, ledgers: [] };
    let asOf = null;

    for (const row of result.rows) {
      const balance = -(Number(row.closing_balance) || 0);
      const entry = {
        ledger_name: row.ledger_name,
        parent_group: row.parent_group,
        balance: round2(balance),
      };

      if (!asOf || row.updated_at > asOf) asOf = row.updated_at;

      if (isCashGroup(row.parent_group)) {
        cash.balance += balance;
        cash.ledger_count++;
        cash.ledgers.push(entry);
        continue;
      }

      const isOd = isOdGroup(row.parent_group);
      entry.is_od = isOd;
      bank.balance += balance;
      bank.ledger_count++;
      // An OD account in credit (balance < 0 here) is the amount drawn.
      if (isOd) {
        bank.od_limit += Math.abs(Number(row.od_limit) || 0);
        if (balance < 0) bank.od_utilised += -balance;
      }
      bank.ledgers.push(entry);
    }

    const byBalance = (a, b) => Math.abs(b.balance) - Math.abs(a.balance);
    cash.ledgers.sort(byBalance);
    bank.ledgers.sort(byBalance);

    return res.status(200).json({
      status: "success",
      source: "database",
      company_id: companyId,
      as_of: asOf,
      data: {
        cash: { ...cash, balance: round2(cash.balance) },
        bank: {
          ...bank,
          balance: round2(bank.balance),
          od_utilised: round2(bank.od_utilised),
          od_limit: round2(bank.od_limit),
        },
      },
    });
  } catch (err) {
    console.error("❌ CASH/BANK BALANCE ERROR:", err.message);

    return res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

export default router;
