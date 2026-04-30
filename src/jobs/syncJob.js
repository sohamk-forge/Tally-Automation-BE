import { syncQueue } from "../queues/syncQueue.js";

export const runProductSync = async (company) => {
  await syncQueue.add("sync-products", { company });
};