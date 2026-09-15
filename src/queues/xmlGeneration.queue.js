// Dedicated queue for the one genuinely fragile step in the purchase/sales
// push pipelines: spawning python (generator.py / sales_generator.py) to
// build the Tally XML. Running that under the SAME concurrency as
// pushInvoice.worker.js/pushSalesInvoice.worker.js (5) meant up to 5
// python.exe processes could be alive at once — which reproducibly caused
// a native access-violation crash under load (confirmed: the exact same
// payload succeeds 5/5 in isolation, fails repeatedly at concurrency 5).
// Isolating XML generation onto its own low-concurrency queue fixes the
// crash at its actual source, without serializing the DB validation /
// connector-job-creation work in the calling workers, which was never the
// problem and doesn't need to be slow.
import { Queue, QueueEvents } from "bullmq";
import { redisConnection } from "../config/redis.js";

export const XML_GENERATION_QUEUE_NAME = "xml-generation";

export const xmlGenerationQueue = new Queue(
  XML_GENERATION_QUEUE_NAME,
  {
    connection: redisConnection,
    defaultJobOptions: {
      // No internal retry here — the calling worker (pushInvoice.worker.js /
      // pushSalesInvoice.worker.js) already classifies "Python exited with
      // code..." as a temporary error and re-throws for BullMQ's own
      // attempts:3/backoff to retry the WHOLE push. Retrying at both layers
      // would silently multiply attempts (up to 3x3) and stack delays.
      attempts: 1,
      removeOnComplete: 200,
      removeOnFail: 200
    }
  }
);

// waitUntilFinished() needs one shared QueueEvents instance listening on
// this queue — creating a fresh one per call would miss the completion
// event fired before its own listener attaches.
export const xmlGenerationQueueEvents = new QueueEvents(
  XML_GENERATION_QUEUE_NAME,
  { connection: redisConnection }
);

/**
 * Enqueues one XML-generation job and awaits its own result — from the
 * caller's point of view this behaves exactly like the old direct
 * generateXml()/generateSalesXml() call (same resolve-with-XML-string /
 * reject-with-Error shape), just routed through the low-concurrency queue
 * instead of spawning python inline.
 *
 * @param {"purchase"|"sales"} type
 * @param {object} invoiceData
 * @returns {Promise<string>} the generated XML
 */
export async function generateXmlViaQueue(type, invoiceData) {
  const job = await xmlGenerationQueue.add(type, { type, invoiceData });
  return job.waitUntilFinished(xmlGenerationQueueEvents, 120_000);
}
