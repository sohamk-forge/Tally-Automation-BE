    import express from "express";
    import pool from "../db/index.js";

    const router = express.Router();

    /* ===================================================
    UNITS DB API
    =================================================== */

    router.get(

    "/",

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
                "company query parameter required"

            });

        }

        /* =========================================
            DATABASE QUERY
        ========================================= */

        const result =

            await pool.query(

            `
            SELECT

                id,

                company_id,

                company_name,

                unit_name,

                created_at,

                updated_at

            FROM app_test.units

            WHERE LOWER(company_name)
            = LOWER($1)

            ORDER BY unit_name
            `,

            [company]

            );

        /* =========================================
            NO DATA
        ========================================= */

        if (!result.rows.length) {

            return res.status(404).json({

            status: "error",

            source: "database",

            message:
                "No units found",

            company,

            data: []

            });

        }

        /* =========================================
            SUCCESS RESPONSE
        ========================================= */

        return res.status(200).json({

            status: "success",

            source: "database",

            company,

            count:
            result.rows.length,

            data:

            result.rows.map((row) => ({

                id:
                Number(row.id),

                company_id:
                Number(row.company_id),

                company_name:
                row.company_name,

                unit_name:
                row.unit_name,

                created_at:
                row.created_at,

                updated_at:
                row.updated_at

            }))

        });

        } catch (err) {

        console.log(

            "❌ UNITS DB ERROR:",

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