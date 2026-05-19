import express from "express";

import pool from "../db/index.js";

const router = express.Router();

/* ===================================================
   SALES ITEMS API
===================================================

API:
GET /api/sales-items

Example:

/api/sales-items
?company=Ratanseva Automobiles Pvt.Ltd. 2025-2026 - (from 1-Apr-25)

=================================================== */

router.get(

  "/sales-items",

  async (req, res) => {

    try {

      /* =========================================
         QUERY PARAMS
      ========================================= */

      const company =
        req.query.company;

      /* =========================================
         VALIDATION
      ========================================= */

      if (!company) {

        return res.status(400).json({

          status: "error",

          message:
            "company required"

        });

      }

      /* =========================================
         GET VOUCHERS
      ========================================= */

      const vouchers =

        await pool.query(

          `
          SELECT *

          FROM app.vouchers

          WHERE company_name = $1

          ORDER BY id DESC
          `,

          [company]

        );

      /* =========================================
         FINAL RESULT
      ========================================= */

      const result = [];

      /* =========================================
         LOOP VOUCHERS
      ========================================= */

      for (const voucher of vouchers.rows) {

        try {

          /* =====================================
             LEDGER ENTRIES
          ===================================== */

          const entries =

            Array.isArray(
              voucher.ledger_entries
            )

              ? voucher.ledger_entries

              : [];

          /* =====================================
             GST CALCULATION
          ===================================== */

          let cgst = 0;

          let sgst = 0;

          for (const entry of entries) {

            const ledgerName =

              entry?.LEDGERNAME || "";

            const amount =

              Math.abs(

                Number(
                  entry?.AMOUNT || 0
                )

              );

            if (

              ledgerName
                .toLowerCase()
                .includes("cgst")

            ) {

              cgst += amount;

            }

            if (

              ledgerName
                .toLowerCase()
                .includes("sgst")

            ) {

              sgst += amount;

            }

          }

          /* =====================================
             INVENTORY ITEMS
          ===================================== */

          for (const entry of entries) {

            const inventoryAllocations =

              entry?.[
                "INVENTORYALLOCATIONS.LIST"
              ];

            const allocations =

              Array.isArray(
                inventoryAllocations
              )

                ? inventoryAllocations

                : inventoryAllocations

                ? [inventoryAllocations]

                : [];

            /* =================================
               LOOP ITEMS
            ================================= */

            for (const item of allocations) {

              const salesItem = {

                company_name:
                  company,

                description:
                  item?.STOCKITEMNAME || null,

                actual_quantity:
                  item?.ACTUALQTY || null,

                billed_quantity:
                  item?.BILLEDQTY || null,

                billing:
                  Number(

                    (
                      cgst + sgst
                    ).toFixed(2)

                  ),

                total_amount:
                  Math.abs(

                    Number(
                      voucher.credit_amount || 0
                    )

                  )

              };

              /* ===============================
                 SAVE INTO TABLE
              =============================== */

              await pool.query(

                `
                INSERT INTO app.sales_items (

                  company_name,

                  description,

                  actual_quantity,

                  billed_quantity,

                  billing,

                  total_amount

                )

                VALUES ($1, $2, $3, $4, $5, $6)
                `,

                [

                  salesItem.company_name,

                  salesItem.description,

                  salesItem.actual_quantity,

                  salesItem.billed_quantity,

                  salesItem.billing,

                  salesItem.total_amount

                ]

              );

              /* ===============================
                 RESPONSE ARRAY
              =============================== */

              result.push(
                salesItem
              );

            }

          }

        } catch (innerErr) {

          console.log(

            "❌ SALES ITEM LOOP ERROR:",

            innerErr.message

          );

        }

      }

      /* =========================================
         RESPONSE
      ========================================= */

      return res.status(200).json({

        status: "success",

        source: "database",

        company,

        total:
          result.length,

        data:
          result

      });

    } catch (err) {

      console.log(

        "❌ SALES ITEMS ERROR:",

        err.message

      );

      return res.status(500).json({

        status: "error",

        message:
          err.message

      });

    }

  }

);

export default router;