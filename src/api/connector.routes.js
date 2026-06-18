// import express from "express";
// import pool from "../db/index.js";

// const router = express.Router();

// /* =========================================
//    CONNECTOR HEARTBEAT
// ========================================= */

// router.post(

//   "/heartbeat",

//   async (req, res) => {

//     try {

//       const {

//         machine_id,

//         machine_name,

//         os_name,

//         connector_version,

//         tally_connected

//       } = req.body;

//       if (!machine_id) {

//         return res.status(400).json({

//           status: "error",

//           message: "machine_id required"

//         });

//       }

//       const existing = await pool.query(

//         `
//         SELECT id

//         FROM app_test.connector_machines

//         WHERE machine_id = $1

//         LIMIT 1
//         `,

//         [

//           machine_id

//         ]

//       );

//       /* =====================================
//          UPDATE EXISTING MACHINE
//       ===================================== */

//       if (existing.rows.length > 0) {

//         await pool.query(

//           `
//           UPDATE app_test.connector_machines

//           SET

//             machine_name = $2,

//             os_name = $3,

//             connector_version = $4,

//             tally_connected = $5,

//             last_seen = NOW(),

//             updated_at = NOW()

//           WHERE machine_id = $1
//           `,

//           [

//             machine_id,

//             machine_name || "",

//             os_name || "",

//             connector_version || "",

//             tally_connected ?? false

//           ]

//         );

//       }

//       /* =====================================
//          INSERT NEW MACHINE
//       ===================================== */

//       else {

//         await pool.query(

//           `
//           INSERT INTO app_test.connector_machines
//           (

//             machine_id,

//             machine_name,

//             os_name,

//             connector_version,

//             tally_connected,

//             last_seen,

//             created_at,

//             updated_at

//           )

//           VALUES
//           (

//             $1,

//             $2,

//             $3,

//             $4,

//             $5,

//             NOW(),

//             NOW(),

//             NOW()

//           )
//           `,

//           [

//             machine_id,

//             machine_name || "",

//             os_name || "",

//             connector_version || "",

//             tally_connected ?? false

//           ]

//         );

//       }

//       return res.status(200).json({

//         status: "success",

//         message: "Connector heartbeat updated"

//       });

//     }

//     catch (err) {

//       console.log(

//         "❌ CONNECTOR HEARTBEAT ERROR:",

//         err.message

//       );

//       return res.status(500).json({

//         status: "error",

//         message: err.message

//       });

//     }

//   }

// );

// /* =========================================
//    GET ALL CONNECTOR MACHINES
// ========================================= */

// router.get(

//   "/status",

//   async (req, res) => {

//     try {

//       const result = await pool.query(

//         `
//         SELECT

//           id,

//           machine_id,

//           machine_name,

//           os_name,

//           connector_version,

//           tally_connected,

//           last_seen,

//           created_at,

//           updated_at

//         FROM app_test.connector_machines

//         ORDER BY updated_at DESC
//         `

//       );

//       return res.status(200).json({

//         status: "success",

//         count: result.rows.length,

//         data: result.rows

//       });

//     }

//     catch (err) {

//       console.log(

//         "❌ GET CONNECTOR STATUS ERROR:",

//         err.message

//       );

//       return res.status(500).json({

//         status: "error",

//         message: err.message

//       });

//     }

//   }

// );

// export default router;