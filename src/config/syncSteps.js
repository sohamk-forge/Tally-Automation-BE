// How many runSyncStep() calls the manual sync job in src/workers/sync.worker.js
// makes. Sent to the browser with every sync status so the progress loader
// ("x / N steps") always matches the real job. When a step is added or removed
// in the worker, change this number — the worker logs a warning if they differ.
export const SYNC_STEP_COUNT = 14;
