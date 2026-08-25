/**
 * src/api/ledgerpdf.routes.js
 *
 * GET /api/v1/ledger-pdf
 *
 * Query params:
 *   company_id
 *   ledgerName
 *   fromDate
 *   toDate
 *   mode = simple | detailed_inventory | detailed_narration
 */

import express from "express";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { buildLedgerPdf } from "../services/ledger-pdf.service.js";

const router = express.Router();

const VALID_MODES = [
  "simple",
  "detailed_inventory",
  "detailed_narration",
];


/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function safeParseLedgerEntries(rawEntriesText) {
  if (!rawEntriesText) {
    return [];
  }

  // Sometimes pg may already return an object/array depending on configuration
  if (Array.isArray(rawEntriesText)) {
    return rawEntriesText;
  }

  if (typeof rawEntriesText === "object") {
    return rawEntriesText;
  }

  try {
    const parsed = JSON.parse(rawEntriesText);

    return Array.isArray(parsed)
      ? parsed
      : parsed
        ? [parsed]
        : [];
  } catch (err) {
    console.warn(
      "[LedgerPdf] skipping unparsable ledger_entries:",
      err.message
    );

    return [];
  }
}


function entriesContainLedger(rawEntriesText, ledgerNameLower) {
  const entries = safeParseLedgerEntries(rawEntriesText);

  if (!Array.isArray(entries)) {
    return false;
  }

  return entries.some((entry) => {
    const entryLedgerName =
      entry?.LEDGERNAME ??
      entry?.ledgername ??
      entry?.ledgerName ??
      "";

    return String(entryLedgerName)
      .trim()
      .toLowerCase() === ledgerNameLower;
  });
}


function normalizeDate(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value).slice(0, 10);
  }

  return date.toISOString().slice(0, 10);
}


/* -------------------------------------------------------------------------- */
/* Company Letterhead                                                         */
/* -------------------------------------------------------------------------- */

async function getCompanyLetterhead(companyId, fallbackName) {
  try {
    const result = await pool.query(
      `
        SELECT
          company_name,
          address,
          state,
          email,
          gstin
        FROM ${DB_SCHEMA}.company_details
        WHERE company_id = $1
        LIMIT 1
      `,
      [companyId]
    );

    const row = result.rows[0];

    if (!row) {
      return {
        name: fallbackName || "",
      };
    }

    return {
      name:
        row.company_name ||
        fallbackName ||
        "",

      address: [
        row.address,
        row.state,
      ]
        .filter(Boolean)
        .join(", "),

      email: row.email || undefined,

      gstin: row.gstin || undefined,
    };
  } catch (err) {
    console.warn(
      "[LedgerPdf] company_details lookup failed:",
      err.message
    );

    return {
      name: fallbackName || "",
    };
  }
}


/* -------------------------------------------------------------------------- */
/* Route                                                                      */
/* -------------------------------------------------------------------------- */

router.get("/", async (req, res) => {
  try {
    const {
      company_id,
      ledgerName,
      fromDate,
      toDate,
    } = req.query;

    const mode = VALID_MODES.includes(req.query.mode)
      ? req.query.mode
      : "simple";


    /* ---------------------------------------------------------------------- */
    /* Validation                                                             */
    /* ---------------------------------------------------------------------- */

    if (!company_id) {
      return res.status(400).json({
        success: false,
        error: "company_id is required",
      });
    }

    if (!ledgerName) {
      return res.status(400).json({
        success: false,
        error: "ledgerName is required",
      });
    }

    if (!fromDate || !toDate) {
      return res.status(400).json({
        success: false,
        error: "fromDate and toDate are required",
      });
    }

    const from = new Date(fromDate);
    const to = new Date(toDate);

    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime())
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Invalid date format. Use YYYY-MM-DD.",
      });
    }

    if (from > to) {
      return res.status(400).json({
        success: false,
        error:
          `fromDate (${fromDate}) is after toDate (${toDate}). ` +
          "Check the financial-year date range.",
      });
    }


    const ledgerNameLower = String(ledgerName)
      .trim()
      .toLowerCase();


    /* ---------------------------------------------------------------------- */
    /* Get all vouchers in date range                                         */
    /* ---------------------------------------------------------------------- */

    const rangeResult = await pool.query(
      `
        SELECT
          id,
          voucher_date,
          voucher_type,
          voucher_number,
          party_ledger_name,
          narration,
          debit_amount AS debit,
          credit_amount AS credit,
          company_name,

          ledger_entries::text AS ledger_entries_raw

        FROM ${DB_SCHEMA}.vouchers

        WHERE company_id = $1
          AND DATE(voucher_date) BETWEEN $2 AND $3

        ORDER BY
          voucher_date ASC,
          id ASC
      `,
      [
        company_id,
        fromDate,
        toDate,
      ]
    );


    /* ---------------------------------------------------------------------- */
    /* Match ledger                                                           */
    /* ---------------------------------------------------------------------- */

    const matchedRows = rangeResult.rows.filter((row) => {
      const partyName = String(
        row.party_ledger_name ?? ""
      )
        .trim()
        .toLowerCase();


      // Direct party ledger match
      if (partyName === ledgerNameLower) {
        return true;
      }


      // Match inside ledger_entries
      return entriesContainLedger(
        row.ledger_entries_raw,
        ledgerNameLower
      );
    });


    /* ---------------------------------------------------------------------- */
    /* Safely prepare vouchers                                                 */
    /* ---------------------------------------------------------------------- */

    const vouchers = matchedRows.map((row) => ({
      id: row.id,

      voucher_date: row.voucher_date,

      voucher_type: row.voucher_type,

      voucher_number: row.voucher_number,

      party_ledger_name: row.party_ledger_name,

      narration: row.narration,

      debit: Number(row.debit) || 0,

      credit: Number(row.credit) || 0,

      company_name: row.company_name,

      // IMPORTANT:
      // Always use safe parsing.
      // Even a party-name match may have malformed ledger_entries.
      ledger_entries: safeParseLedgerEntries(
        row.ledger_entries_raw
      ),
    }));


    /* ---------------------------------------------------------------------- */
    /* No vouchers found in selected range                                    */
    /* ---------------------------------------------------------------------- */

    if (vouchers.length === 0) {
      const allResult = await pool.query(
        `
          SELECT
            voucher_date,
            party_ledger_name,
            ledger_entries::text AS ledger_entries_raw

          FROM ${DB_SCHEMA}.vouchers

          WHERE company_id = $1
        `,
        [company_id]
      );


      const allMatches = allResult.rows.filter((row) => {
        const partyName = String(
          row.party_ledger_name ?? ""
        )
          .trim()
          .toLowerCase();


        if (partyName === ledgerNameLower) {
          return true;
        }


        return entriesContainLedger(
          row.ledger_entries_raw,
          ledgerNameLower
        );
      });


      /* -------------------------------------------------------------------- */
      /* Ledger never found                                                   */
      /* -------------------------------------------------------------------- */

      if (allMatches.length === 0) {
        const suggestResult = await pool.query(
          `
            SELECT DISTINCT party_ledger_name

            FROM ${DB_SCHEMA}.vouchers

            WHERE company_id = $1
              AND party_ledger_name ILIKE $2
              AND party_ledger_name IS NOT NULL

            LIMIT 5
          `,
          [
            company_id,
            `%${ledgerName}%`,
          ]
        );


        return res.status(404).json({
          success: false,

          error:
            `No vouchers found for ledger "${ledgerName}" ` +
            `under company_id=${company_id}. ` +
            "Check spelling or company_id.",

          similarNames: suggestResult.rows
            .map((row) => row.party_ledger_name)
            .filter(Boolean),
        });
      }


      /* -------------------------------------------------------------------- */
      /* Ledger exists but outside date range                                 */
      /* -------------------------------------------------------------------- */

      const validDates = allMatches
        .map((row) => new Date(row.voucher_date))
        .filter((date) => !Number.isNaN(date.getTime()));


      const actualDateRange =
        validDates.length > 0
          ? {
              earliest: normalizeDate(
                new Date(
                  Math.min(
                    ...validDates.map(
                      (date) => date.getTime()
                    )
                  )
                )
              ),

              latest: normalizeDate(
                new Date(
                  Math.max(
                    ...validDates.map(
                      (date) => date.getTime()
                    )
                  )
                )
              ),
            }
          : null;


      return res.status(404).json({
        success: false,

        error:
          `Ledger "${ledgerName}" has ${allMatches.length} voucher(s) ` +
          `for this company, but none between ${fromDate} and ${toDate}.`,

        actualDateRange,
      });
    }


    /* ---------------------------------------------------------------------- */
    /* Company letterhead                                                     */
    /* ---------------------------------------------------------------------- */

    const company = await getCompanyLetterhead(
      company_id,
      vouchers[0]?.company_name
    );


    /* ---------------------------------------------------------------------- */
    /* Generate PDF                                                           */
    /* ---------------------------------------------------------------------- */

    const pdfBuffer = await buildLedgerPdf({
      mode,

      company,

      ledgerName,

      fromDate,

      toDate,

      // Keep this until real opening balance logic is implemented
      openingBalance: 0,

      vouchers,
    });


    const safeFilename = String(ledgerName)
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "");


    res.setHeader(
      "Content-Type",
      "application/pdf"
    );

    res.setHeader(
      "Content-Disposition",
      `inline; filename="${safeFilename || "ledger"}-ledger.pdf"`
    );

    res.setHeader(
      "Content-Length",
      pdfBuffer.length
    );


    return res
      .status(200)
      .send(pdfBuffer);


  } catch (err) {
    console.error(
      "[LedgerPdf] Error:",
      err
    );

    return res.status(500).json({
      success: false,

      error:
        err?.message ||
        "Failed to generate ledger PDF",
    });
  }
});


export default router;