// import express from "express";
// import pool from "../db/index.js";

// const router = express.Router();

// router.get("/sync-jobs", async (req, res) => {
//     try {
//         const result = await pool.query(
//             `
//             SELECT
//                 id,
//                 job_type,
//                 status,
//                 payload,
//                 created_at
//             FROM app_test.job_logs
//             WHERE status = 'pending'
//             ORDER BY created_at ASC
//             LIMIT 1
//             `
//         );

//         return res.status(200).json({
//             status: "success",
//             count: result.rows.length,
//             data: result.rows
//         });

//     } catch (err) {
//         console.error("GET SYNC JOBS ERROR:", err);
//         return res.status(500).json({
//             status: "error",
//             message: err.message
//         });
//     }
// });

// router.post("/job-status", async (req, res) => {
//     try {
//         const {
//             job_id,
//             status,
//             error_message,
//             raw_response
//         } = req.body;

//         if (!job_id || !status) {
//             return res.status(400).json({
//                 status: "error",
//                 message: "job_id and status are required"
//             });
//         }

//         if (raw_response) {
//             console.log("=================================");
//             console.log("RAW RESPONSE RECEIVED");
//             console.log("=================================");
//             console.log(raw_response);
//             console.log("=================================");
//         }

//         // ✅ FIX: Include "tally_responded" as a terminal status
//         const completedAt = 
//             status === "completed" || status === "failed" || status === "tally_responded"
//                 ? new Date()
//                 : null;

//         await pool.query(
//             `
//             UPDATE app_test.job_logs
//             SET
//                 status = $1,
//                 error_message = $2,
//                 raw_response = $3,
//                 completed_at = COALESCE($4, completed_at)
//             WHERE id = $5
//             `,
//             [
//                 status,
//                 error_message || null,
//                 raw_response || null,  // ✅ Store raw response
//                 completedAt,
//                 job_id
//             ]
//         );

//         return res.status(200).json({
//             status: "success",
//             message: "Job status updated successfully"
//         });

//     } catch (err) {
//         console.error("JOB STATUS ERROR:", err);
//         return res.status(500).json({
//             status: "error",
//             message: err.message
//         });
//     }
// });

// router.post("/job-start", async (req, res) => {
//     try {
//         const { job_id } = req.body;

//         if (!job_id) {
//             return res.status(400).json({
//                 status: "error",
//                 message: "job_id is required"
//             });
//         }

//         const result = await pool.query(
//             `
//             UPDATE app_test.job_logs
//             SET
//                 status = 'running',
//                 started_at = NOW()
//             WHERE id = $1
//               AND status = 'pending'
//             RETURNING *
//             `,
//             [job_id]
//         );

//         if (result.rows.length === 0) {
//             return res.status(404).json({
//                 status: "error",
//                 message: "Pending job not found or already running."
//             });
//         }

//         return res.status(200).json({
//             status: "success",
//             message: "Job started successfully",
//             data: result.rows[0]
//         });

//     } catch (err) {
//         console.error("JOB START ERROR:", err);
//         return res.status(500).json({
//             status: "error",
//             message: err.message
//         });
//     }
// });

// export default router;