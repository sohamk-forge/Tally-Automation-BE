    import express from "express";
    import pool from "../db/index.js";

    import {
    alterStockItemQueue,
    ALTER_STOCK_ITEM_JOB_OPTIONS,
    getAlterStockItemJobId
    } from "../queues/alterStockItem.queue.js";

    const router = express.Router();

    router.post(
    "/push/stock-item-opening",
    async (req, res) => {

        try {

        const data = req.body;

        console.log("BODY RECEIVED:");
console.log(req.body);

        console.log(
            "===================================="
        );
        console.log(
            "PUSH STOCK ITEM OPENING API HIT"
        );
        console.log(
            "===================================="
        );
        console.log(
            JSON.stringify(data, null, 2)
        );

        if (
            !data.company ||
            !data.item_name
        ) {
            return res.status(400).json({
            status: "error",
            message:
                "company and item_name are required"
            });
        }

        const stockItemResult =
            await pool.query(
            `
            SELECT id
            FROM app_test.push_stock_item
            WHERE
                TRIM(company_name) = TRIM($1)
                AND TRIM(item_name) = TRIM($2)
                AND status = 'success'
            `,
            [
                data.company,
                data.item_name
            ]
            );

        const stockItem =
            stockItemResult.rows[0];

        if (!stockItem) {
            return res.status(404).json({
            status: "error",
            message:
                "Stock item not found or not synced"
            });
        }

      const updateResult = await pool.query(
  `
  UPDATE app_test.push_stock_item
  SET
    opening_quantity = $1,
    opening_rate = $2,
    opening_value = $3,
    updated_at = NOW()
  WHERE id = $4
  RETURNING
    id,
    item_name,
    opening_quantity,
    opening_rate,
    opening_value
  `,
  [
    data.opening_quantity || 0,
    data.opening_rate || 0,
    data.opening_value || 0,
    stockItem.id
  ]
);

console.log("UPDATED DB RECORD:");
console.log(updateResult.rows[0]);

        await alterStockItemQueue.add(
            "push-alter-stock-item",
            {
            stockItemId: stockItem.id
            },
            {
            ...ALTER_STOCK_ITEM_JOB_OPTIONS,
           jobId: `${stockItem.id}-${Date.now()}`
            }
        );

        console.log(
            `Opening stock queued: ${data.item_name}`
        );

        return res.status(200).json({
            status: "success",
            message:
            "Opening stock queued successfully"
        });

        } catch (error) {

        console.error(
            "ERROR:",
            error.message
        );

        return res.status(500).json({
            status: "error",
            message: error.message
        });
        }
    }
    );

    export default router;