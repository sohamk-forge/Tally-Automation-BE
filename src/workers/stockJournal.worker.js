
import { Worker, UnrecoverableError } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { STOCK_JOURNAL_QUEUE_NAME } from "../queues/stockJournal.queue.js";
import { createStockJournalXML } from "../services/stockJournalXmlBuilder.js";
import { createConnectorJob } from "../services/connectorJob.service.js";
import {
  resolveConnectorForCompany,
  getConnectorOfflineMessage
} from "../services/connectorOwner.service.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  password: process.env.REDIS_PASSWORD || undefined,
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

new Worker(
  STOCK_JOURNAL_QUEUE_NAME,
  async (job) => {
    const { stockJournalId, userId } = job.data;

    if (!stockJournalId || !userId) {
      throw new UnrecoverableError(
        "stockJournalId and userId are required"
      );
    }

    const result = await pool.query(
      `SELECT * FROM ${DB_SCHEMA}.push_stock_journals
       WHERE id = $1`,
      [stockJournalId]
    );

    const journal = result.rows[0];

    if (!journal) {
      throw new UnrecoverableError("Stock Journal not found");
    }

    // Avoid creating another connector job for an already
    // handed-off journal when BullMQ retries the task.
    if (journal.connector_job_id || journal.status === "success") {
      return {
        stockJournalId,
        status: journal.status,
        connectorJobId: journal.connector_job_id
      };
    }

    await pool.query(
      `UPDATE ${DB_SCHEMA}.push_stock_journals
       SET status = 'processing', updated_at = NOW()
       WHERE id = $1`,
      [stockJournalId]
    );

    try {
      const entryResult = await pool.query(
        `SELECT * FROM ${DB_SCHEMA}.push_stock_journal_entries
         WHERE stock_journal_id = $1
         ORDER BY id`,
        [stockJournalId]
      );

      if (!entryResult.rows.length) {
        throw new UnrecoverableError(
          "Stock Journal has no entries"
        );
      }

      const xml = createStockJournalXML({
        company: journal.company_name,
        voucherDate: journal.voucher_date,
        voucherNumber: journal.voucher_number,
        narration: journal.narration,
        entries: entryResult.rows
      });

      const connector = await resolveConnectorForCompany(
        journal.company_id,
        userId
      );

      if (!connector) {
        throw new Error(
          await getConnectorOfflineMessage(
            journal.company_id,
            userId,
            `No active connector found for company ${journal.company_id}`
          )
        );
      }

      const connectorJob = await createConnectorJob({
        userId: connector.user_id,
        jobType: "stock_journal",
        requestXml: xml,
        payload: {
          stock_journal_id: stockJournalId,
          company_id: journal.company_id,
          voucher_number: journal.voucher_number,
          requested_by_user_id: userId,
          machine_id: connector.machine_id
        }
      });

      // Do not throw after creating the connector job:
      // retrying could create a duplicate stock transfer.
      await pool.query(
        `UPDATE ${DB_SCHEMA}.push_stock_journals
         SET status = 'pending_connector',
             connector_job_id = $2,
             error_message = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [stockJournalId, connectorJob.id]
      );

      return {
        stockJournalId,
        status: "pending_connector",
        connectorJobId: connectorJob.id
      };
    } catch (error) {
      await pool.query(
        `UPDATE ${DB_SCHEMA}.push_stock_journals
         SET status = 'failed',
             error_message = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [error.message, stockJournalId]
      );

      throw error;
    }
  },
  {
    connection,
    concurrency: 5
  }
);
