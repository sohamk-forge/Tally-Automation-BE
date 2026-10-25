// The steps of the manual sync job in src/workers/sync.worker.js, in the order
// the worker runs them. The browser gets the count with every sync status so the
// progress loader ("x / N steps") always matches the real job, and the label of
// the step that is running now, so a slow step doesn't look like a frozen loader.
// When a step is added or removed in the worker, change this list — the worker
// logs a warning if they differ.
export const SYNC_STEP_LABELS = [
  "COMPANY DETAILS",
  "ALL LEDGERS",
  "BANK ACCOUNTS",
  "STOCK GROUP GST DETAILS",
  "STOCK GROUP SUMMARY",
  "UNITS",
  "GODOWNS",
  "PURCHASE/SALES LEDGERS",
  "PAYABLE/DEBTORS",
  "PARENT GROUPS",
  "PROFIT & LOSS",
  "PROFIT & LOSS SUMMARY",
  "VOUCHERS",
  "SALES INVOICE DELIVERY DETAILS"
];

export const SYNC_STEP_COUNT = SYNC_STEP_LABELS.length;
