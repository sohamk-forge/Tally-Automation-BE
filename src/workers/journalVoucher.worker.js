import { Worker, UnrecoverableError } from "bullmq";
import IORedis from "ioredis";

import pool from "../db/index.js";

import {
  DB_SCHEMA
} from "../config/db.js";

import {
  JOURNAL_VOUCHER_QUEUE_NAME
} from "../queues/journalVoucher.queue.js";

import {
  createJournalVoucherXML
} from "../services/journalVoucherXmlBuilder.js";

import {
  createConnectorJob
} from "../services/connectorJob.service.js";

import {
  resolveConnectorForCompany,
  getConnectorOfflineMessage
} from "../services/connectorOwner.service.js";


const connection = new IORedis({
  host:
    process.env.REDIS_HOST ||
    "127.0.0.1",

  password:
    process.env.REDIS_PASSWORD ||
    undefined,

  port: Number(
    process.env.REDIS_PORT || 6379
  ),

  maxRetriesPerRequest: null
});


const worker = new Worker(

  JOURNAL_VOUCHER_QUEUE_NAME,

  async (job) => {

    const {
      voucherId,
      userId
    } = job.data;


    if (!voucherId) {
      throw new Error(
        "voucherId is required"
      );
    }


    if (!userId) {
      throw new Error(
        "userId is required"
      );
    }


    console.log(
      `[JOURNAL] Processing voucher ${voucherId}`
    );


    // --------------------------------
    // GET VOUCHER
    // --------------------------------

    const voucherResult =
      await pool.query(
        `
        SELECT *
        FROM ${DB_SCHEMA}.push_journal_vouchers
        WHERE id = $1
        `,
        [voucherId]
      );


    const voucher =
      voucherResult.rows[0];


    if (!voucher) {
      throw new UnrecoverableError(
        `Voucher ${voucherId} not found`
      );
    }


    // --------------------------------
    // ALREADY HANDED OFF / FINISHED
    // --------------------------------

    // A retry (or a duplicate enqueue) must never create a second connector
    // job — that would post the same journal into Tally twice.
    if (
      voucher.connector_job_id ||
      voucher.status === "success"
    ) {
      console.log(
        `[JOURNAL] Voucher ${voucherId} already handed off (connector job ${voucher.connector_job_id}), skipping`
      );

      return {
        voucherId,
        status: voucher.status,
        connectorJobId:
          voucher.connector_job_id
      };
    }


    // --------------------------------
    // STATUS = PROCESSING
    // --------------------------------

    await pool.query(
      `
      UPDATE
      ${DB_SCHEMA}.push_journal_vouchers

      SET
        status = 'processing',
        updated_at = NOW()

      WHERE id = $1
      `,
      [voucherId]
    );


    try {

      // --------------------------------
      // GET ENTRIES
      // --------------------------------

      const entriesResult =
        await pool.query(
          `
          SELECT
            *
          FROM
          ${DB_SCHEMA}.push_journal_voucher_entries
          WHERE
            voucher_id = $1
          ORDER BY id
          `,
          [voucherId]
        );


      const entries =
        entriesResult.rows;


      if (!entries.length) {
        throw new UnrecoverableError(
          "Voucher has no entries"
        );
      }


      // --------------------------------
      // CREATE XML
      // --------------------------------

      // A bad date / unbalanced voucher will fail identically on every
      // attempt, so don't burn the retries (and backoff) on it.
      let xml;

      try {
        xml =
          createJournalVoucherXML({

            company:
              voucher.company_name,

            voucherDate:
              voucher.voucher_date,

            voucherNumber:
              voucher.voucher_number,

            voucherType:
              voucher.voucher_type,

            narration:
              voucher.narration,

            entries
          });
      } catch (xmlError) {
        throw new UnrecoverableError(
          xmlError.message
        );
      }


      console.log(
        "[JOURNAL] XML generated"
      );


      // --------------------------------
      // FIND CONNECTOR
      // --------------------------------

      const connector =
        await resolveConnectorForCompany(
          voucher.company_id,
          userId
        );


      if (!connector) {

        throw new Error(
          await getConnectorOfflineMessage(
            voucher.company_id,
            userId,
            `No active connector found for company ${voucher.company_id}`
          )
        );
      }


      console.log(
        `[JOURNAL] Connector resolved: ${connector.user_id}`
      );


      // --------------------------------
      // CREATE CONNECTOR JOB
      // --------------------------------

      const connectorJob =
        await createConnectorJob({

          userId:
            connector.user_id,

          // Underscore, like every other job type — and the key
          // connectorJobResult.service.js switches on to close the loop.
          jobType:
            "journal_voucher",

          requestXml:
            xml,

          payload: {

            voucher_id:
              voucherId,

            company_id:
              voucher.company_id,

            voucher_number:
              voucher.voucher_number,

            requested_by_user_id:
              userId,

            machine_id:
              connector.machine_id
          }
        });


      console.log(
        `[JOURNAL] Connector job created: ${connectorJob.id}`
      );


      // --------------------------------
      // STATUS = PENDING_CONNECTOR
      // --------------------------------

      // Distinct from 'pending' (queued, not yet picked up by this worker).
      // The connector's result callback is what moves it to success/failed.
      //
      // The connector job already exists at this point, so a failure here
      // must NOT throw: BullMQ would retry and create a second connector job
      // (a duplicate journal in Tally). The result callback updates the
      // voucher by id regardless of this write.
      try {
        await pool.query(
          `
          UPDATE
          ${DB_SCHEMA}.push_journal_vouchers

          SET
            status = 'pending_connector',
            connector_job_id = $2,
            error_message = NULL,
            updated_at = NOW()

          WHERE id = $1
          `,
          [voucherId, connectorJob.id]
        );
      } catch (statusError) {
        console.error(
          `[JOURNAL] Connector job ${connectorJob.id} created for voucher ${voucherId}, but status update failed:`,
          statusError.message
        );
      }


      return {

        voucherId,

        status: "pending_connector",

        connectorJobId:
          connectorJob.id
      };

    } catch (error) {

      console.error(
        `[JOURNAL] Failed voucher ${voucherId}:`,
        error.message
      );


      await pool.query(
        `
        UPDATE
        ${DB_SCHEMA}.push_journal_vouchers

        SET
          status = 'failed',

          error_message = $1,

          updated_at = NOW()

        WHERE id = $2
        `,
        [
          error.message,
          voucherId
        ]
      );


      throw error;
    }
  },

  {
    connection,

    concurrency: 5
  }
);


// --------------------------------
// COMPLETED
// --------------------------------

worker.on(
  "completed",
  (job) => {

    console.log(
      `[JOURNAL] ✅ Job completed: ${job.id}`,
      job.returnvalue
    );

  }
);


// --------------------------------
// FAILED
// --------------------------------

worker.on(
  "failed",
  async (job, error) => {

    console.error(
      `[JOURNAL] ❌ Job failed: ${job?.id}`,
      error.message
    );

  }
);


// --------------------------------
// WORKER ERROR
// --------------------------------

worker.on(
  "error",
  (error) => {

    console.error(
      "[JOURNAL] Worker error:",
      error.message
    );

  }
);


console.log(
  "✅ Journal Voucher BullMQ worker started"
);


export default worker;