import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
export async function createAuditLog({

  action,
  entity,
  metadata = {},
  logType = "INFO"

}) {

  try {

    await pool.query(

      `
     INSERT INTO ${DB_SCHEMA}.audit_logs (

        action,
        entity,
        metadata,
        log_type,
        created_at

      )

      VALUES (

        $1,$2,$3,$4,
        NOW()

      )
      `,

      [

        action,

        entity,

        metadata,

        logType

      ]

    );

  } catch (err) {

    console.log(

      "AUDIT LOG ERROR:",

      err.message

    );

  }

}