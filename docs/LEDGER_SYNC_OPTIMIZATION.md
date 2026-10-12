# Ledger / Group Sync — Analysis & Optimization Plan

Scope: how ledgers, bank accounts and groups are pulled from Tally, why a ledger under a
sub-group (e.g. **S.E.S** under *Sundry Creditors*) shows as **Banking** in the UI while the DB
is correct, and how to fix and speed up the sync.

> Status: analysis only. **No code has been changed.** All findings come from reading the code.
> Nothing here was run against a live Tally or a production DB, and no timings were measured.
> Items marked **[verify]** need a check before implementing.

---

## 1. Summary

| # | Finding | Effect |
|---|---|---|
| 1 | `bank_accounts.parent_group` is hardcoded to `"Bank Accounts"` | Real group (e.g. `Bank OD A/c`) is lost |
| 2 | No sync ever deletes rows Tally no longer returns | Stale ledger stays in `bank_accounts` → shows as Banking |
| 3 | Bank XML filter uses `$Parent = ...` (direct parent only), omits `Bank OCC A/c`, lists `Bank Accounts` twice | Sub-group bank ledgers and OC accounts are missed |
| 4 | `parent_groups` table stores only `group_name`, not the group's parent | Hierarchy (S.E.S → Sundry Creditors) is unavailable in the DB |
| 5 | Ledger page classifies by exact string match on `parent_group` | Ledgers under sub-groups of Debtors/Creditors fall into generic "Ledger" |
| 6 | Several redundant or dead XML requests | Wasted Tally round trips / maintenance |

---

## 2. How it works today

### 2.1 Full sync order (`src/workers/sync.worker.js`)

Steps run **sequentially** (the worker comments that parallel calls would contend for the same
connector slot). Each step is one or more `sendToTallyViaConnector` jobs.

| Step | Route | Tally requests (approx.) |
|---|---|---|
| Company details | `/company-details` | 2 (company + GST) |
| All ledgers | `/all-ledgers-sync` | 1 |
| Bank accounts | `/group-summary-bank` | 1 |
| Stock group GST | `/stock-group-gst-sync` | 1 |
| Stock group summary | `/stock-group-summary-sync` | 1 |
| Units | `/units-sync` | 1 |
| Godowns | `/godown-sync` | 1 |
| Purchase/Sales ledgers | `/purchase-sales-ledgers-sync` | 1 |
| Payable/Debtors | `/payable-debtors` | 5–7 (Debtors, Creditors, Stock-in-Hand ×1–2, Sales, Purchase) |
| Parent groups | `/parent-groups` | 1 |
| Profit & Loss (+ summary) | `/profit-loss-sync`, `/profit-loss-summary-sync` | 2+ |
| Vouchers (+ delivery notes) | `/voucher-sync` … | 1+ |

### 2.2 Why the S.E.S ledger shows as "Banking"

The UI reads two tables for ledgers:

| Table | Fed by | `parent_group` value | UI use |
|---|---|---|---|
| `all_ledger_details` | `getAllLedgersXML` (no filter) | Real Tally `PARENT` → **S.E.S (correct)** | All / Debtor / Creditor tabs |
| `bank_accounts` | `getGroupSummaryBankXML` | **Hardcoded** `"Bank Accounts"` (`sync.routes.js:731`) | Bank / OD / OC tabs, "Parent Group" row in detail view |

Most likely cause (**[verify]** with the SQL in §6): the ledger once sat under a bank group, or
was matched into `bank_accounts` earlier. The sync only upserts, so the row persisted after the
ledger moved to S.E.S, and every bank sync re-stamps it `"Bank Accounts"`.

---

## 3. Optimizations

Each item lists the change, the benefit, and the risk.

### 3.1 Fix correctness (do first)

#### A. Store the real parent group in `bank_accounts`
- **Change:** in `/group-summary-bank`, replace the literal `"Bank Accounts"` with
  `clean(ledger?.PARENT)`.
- **Benefit:** UI/DB show the true group; OD ledgers are no longer mislabeled.
- **Risk:** low. Check `pushBank.worker.js` / `pushBank.routes.js` which default to
  `"Bank Accounts"` — they write to Tally, so they are unaffected.

#### B. Remove rows Tally no longer returns (stale-row cleanup)
- **Change:** at the end of each sync, inside the same transaction, delete (or mark inactive)
  rows for that `company_id` whose `guid` was not in the response. Apply to `bank_accounts` and
  `all_ledger_details`.
  ```sql
  DELETE FROM app_test.bank_accounts
  WHERE company_id = $1 AND guid <> ALL($2::text[]);
  ```
- **Benefit:** fixes the S.E.S symptom permanently; ledgers deleted/moved in Tally disappear
  from the app.
- **Risk:** medium. **Guard it:** skip cleanup if the response is empty or the request failed,
  otherwise one failed fetch wipes the table. Prefer a soft flag (`is_active`) first. Check
  anything that references these rows by id (e.g. `company_ledger_mappings`).

#### C. Fix the bank filter
- **Change (option 1 — in Tally):** use group membership instead of direct parent:
  ```xml
  <SYSTEM TYPE="Formulae" NAME="BankFilter">
    $$IsBelongsTo:Bank Accounts OR $$IsBelongsTo:Bank OD A/c OR $$IsBelongsTo:Bank OCC A/c
  </SYSTEM>
  ```
  **[verify]** this formula on the Tally version in use before shipping.
- **Change (option 2 — in SQL, no TDL risk, preferred):** drop the separate bank XML and derive
  bank ledgers from `all_ledger_details` by walking the group hierarchy (see 3.1D / 3.2B).
- **Benefit:** includes sub-group bank ledgers and OC (Cash Credit) accounts, which are
  currently never fetched. Removes the duplicated `"Bank Accounts"` literal.

#### D. Persist the group hierarchy
- **Problem:** `getParentGroupsXML` fetches `Parent`, `PrimaryGroup`, `IsRevenue`,
  `IsDeemedPositive`, but `/parent-groups` writes only `group_name`
  (`sync.routes.js:1389`). The hierarchy is thrown away.
- **Change:** add a `parent_group` column to `parent_groups` (new migration) and write
  `clean(group?.PARENT)` in the upsert. **[verify]** an earlier migration
  (`20260512120916_remove_extra_columns_parent_groups.js`) removed extra columns — confirm the
  current schema first.
- **Benefit:** enables everything in 3.1E and 3.2B.

#### E. Classify ledgers by hierarchy, not exact string
- **Problem:** `Ledger.jsx:93-98` treats a ledger as debtor/creditor only if `parent_group` is
  exactly `Sundry Debtors` / `Sundry Creditors`.
- **Change:** resolve the ancestor chain in SQL and return a `ledger_type` from the API:
  ```sql
  WITH RECURSIVE chain AS (
    SELECT l.id AS ledger_id, l.parent_group AS grp
    FROM app_test.all_ledger_details l WHERE l.company_id = $1
    UNION ALL
    SELECT c.ledger_id, g.parent_group
    FROM chain c
    JOIN app_test.parent_groups g
      ON g.company_id = $1 AND g.group_name = c.grp
    WHERE g.parent_group IS NOT NULL
  )
  SELECT ledger_id,
         bool_or(grp = 'Sundry Creditors') AS is_creditor,
         bool_or(grp = 'Sundry Debtors')   AS is_debtor,
         bool_or(grp IN ('Bank Accounts','Bank OD A/c','Bank OCC A/c')) AS is_bank
  FROM chain GROUP BY ledger_id;
  ```
  Add a cycle guard (depth limit) before shipping.
- **Benefit:** S.E.S ledgers appear under **Creditor**; Debtor/Creditor/Bank/OD/OC tabs become
  consistent and driven by one source.

### 3.2 Reduce Tally requests / work

#### A. Retire the N+1 `/ledgers` route
- **Where:** `sync.routes.js:507-665`. It fetches ledger names, then sends **one
  `getLedgerDetailsXML` request per ledger** plus a SAVEPOINT per ledger.
- **Correction to earlier analysis:** this route is **not** in the normal full-sync worker
  (the worker calls `/all-ledgers-sync`), and I found no front-end call to it. It only costs
  anything if something invokes `/api/sync/ledgers` directly. **[verify]** no external caller
  (scripts, cron, other clients).
- **Change:** if unused, remove it. The `ledgers` table (`name`, `gst_number`, `guid`) is a
  subset of `all_ledger_details`; `/api/ledgers` (`ledgers.routes.js`) can read
  `all_ledger_details` instead. **[verify]** no other reader of `app_test.ledgers`
  (searched `src/` — only `ledgers.routes.js` reads it).
- **Benefit:** if it is ever called: for N ledgers, `N+1` Tally jobs → 0. Removes a table to
  keep in sync.
- **Risk:** low if confirmed unused; otherwise keep and mark deprecated.

#### B. Derive bank list from `all_ledger_details`
- **Change:** drop `/group-summary-bank` and the `bank_accounts` ledger fetch for the *list*;
  compute bank / OD / OC from the hierarchy query in 3.1E. If bank-only fields
  (`account_number`, `ifsc_code`, `od_limit`) are needed, add them to `getAllLedgersXML`'s
  FETCH list and store them on `all_ledger_details`. **[verify]** which of those fields
  Tally actually returns for non-bank ledgers.
- **Benefit:** −1 Tally request per sync, one source of truth (removes the stale-row class of
  bug), OC works automatically.
- **Risk:** medium — `bank_accounts` is also read by `bankInterest.routes.js`,
  `groupSummaryBank.routes.js`, the Ledger page and the dashboard. Migrate readers first.

#### C. Collapse `/payable-debtors` into one request
- **Where:** `sync.routes.js:1511-1524` makes 5–7 sequential requests, one per group.
- **Change:** one `Collection` of type `Group` filtered to the group names, returning
  `OpeningBalance` / `ClosingBalance` for all of them; map by name in JS.
- **Benefit:** ~5–7 requests → 1 per sync. Removes the "retry with alternate spelling" call
  when matching on `ReservedName`.
- **Risk:** medium — the existing code handles two response shapes (`TALLYMESSAGE` vs
  `COLLECTION`) and special-cases duplicate groups; replicate that logic.
- **Do not** try to speed this up by running requests in parallel: the worker notes the
  connector processes one job at a time.

#### D. Remove dead / duplicate builders
- `getGroupSummaryCRXML`, `getGroupSummaryDRXML`, `getStockInHandXML` — no callers found
  (**[verify]** with a repo-wide grep before deleting).
- CR uses direct-parent `$Parent`, DR uses `CHILDOF` — inconsistent. Delete rather than fix, or
  switch CR to `CHILDOF` if it is ever revived.

### 3.3 Smaller wins

| Change | Benefit |
|---|---|
| Trim alias guesses from the bank FETCH (`BANKACNO`, `BANKACCOUNTNO`, `ACNO`, `ACCOUNTNO`, …) after inspecting one real response | Smaller XML, faster parse |
| Bulk upsert (`INSERT … ON CONFLICT`) instead of select-then-insert/update per row in `upsertRecord` | ~2 DB queries per ledger → a few per sync |
| Single company/ownership lookup per full sync instead of per route | Fewer DB queries |

---

## 4. Expected benefit

No measurements were taken. The numbers below are request counts derived from the code, not
timings.

| Change | Before | After | Notes |
|---|---|---|---|
| Bank parent group + filter (3.1A, C) | OD/OC wrong or missing | Correct | Correctness, no speed change |
| Stale-row cleanup (3.1B) | Stale rows accumulate forever | Mirrors Tally | Fixes the S.E.S symptom |
| Hierarchy-based typing (3.1D–E) | Sub-group ledgers shown as generic "Ledger" | Correct Debtor/Creditor | Needs migration + API change |
| Drop bank request (3.2B) | 1 request | 0 | Plus removes duplicate data |
| Merge group balances (3.2C) | 5–7 requests | 1 | Largest per-sync saving in the worker |
| Retire `/ledgers` (3.2A) | N+1 requests *if called* | 0 | Only matters if something calls it |
| Bulk upserts (3.3) | ~2 queries/row | ~constant per sync | Scales with ledger count |

Full-sync Tally requests: roughly **20–25 → 12–15** after 3.2B and 3.2C (estimate from §2.1).
Actual wall-clock gain depends on connector latency per job; **measure before/after** using
`sync_job_logs` / the `runSyncStep` timings.

---

## 5. Rollout plan

1. **Correctness release (low risk):** 3.1A, 3.1C, then 3.1B behind the empty-response guard.
   Run the §6 SQL before and after to confirm the S.E.S row is gone.
2. **Hierarchy release:** migration for `parent_groups.parent_group` (3.1D), re-sync, then the
   API/UI change (3.1E). Ship the API field first, UI second.
3. **Consolidation release:** 3.2C, then 3.2B after migrating the other `bank_accounts`
   readers. Keep the old route behind a flag for one release.
4. **Cleanup:** 3.2A, 3.2D, 3.3.

For each step: test on one company, compare row counts per table before/after, and keep the
previous XML builders until the new data is verified.

---

## 6. Verification queries

Replace `<ledger>` and `<id>`.

```sql
-- Is the ledger in both tables, with different groups?
SELECT 'bank_accounts' AS src, ledger_name, parent_group, updated_at
FROM app_test.bank_accounts WHERE ledger_name ILIKE '%<ledger>%'
UNION ALL
SELECT 'all_ledger_details', ledger_name, parent_group, updated_at
FROM app_test.all_ledger_details WHERE ledger_name ILIKE '%<ledger>%';

-- Bank rows with no matching ledger-group evidence (stale candidates)
SELECT b.ledger_name, b.parent_group AS stored, a.parent_group AS actual
FROM app_test.bank_accounts b
LEFT JOIN app_test.all_ledger_details a
  ON a.company_id = b.company_id AND a.ledger_name = b.ledger_name
WHERE b.company_id = <id> AND (a.ledger_name IS NULL OR a.parent_group <> b.parent_group);

-- Current parent_groups schema (does it have a parent column?)
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'app_test' AND table_name = 'parent_groups';
```

---

## 7. Open questions

- Is `/api/sync/ledgers` called by anything outside this repo?
- Does the target Tally version support `$$IsBelongsTo` in this filter form?
- Which bank-specific fields (`account_number`, `ifsc_code`, `od_limit`) are actually needed
  for non-bank-tab screens?
- Should removed ledgers be hard-deleted or soft-deleted (history, mappings, vouchers)?

## 8. Reference — XML builders

**Pull (`src/services/xmlBuilder.js`):** `getCompaniesXML`, `getLedgersXML`,
`getLedgerDetailsXML`, `getAllLedgersXML`, `getGroupSummaryBankXML`, `getGroupSummaryCRXML`
(unused), `getGroupSummaryDRXML` (unused), `getLedgerVouchersXML`, `getParentGroupsXML`,
`getGroupBalanceXML`, `getAllParentGroupDetailsXML`, `getProfitLossXML`,
`getProfitLossReportXML`, `getStockGroupSummaryXML`, `getStockGroupGSTXML`, `getUnitsXML`,
`getPurchaseSalesLedgersXML`, `getGodownsXML`, `getSalesGroupXML`, `getPurchaseGroupXML`,
`getStockInHandXML` (unused), `getCompanyDetailsXML`, `getCompanyGSTDetailsXML`,
`getSalesVoucherExistsXML`, `getSalesInvoiceDetailsXML`.

**Push (`src/services/pushXmlBuilder.js`):** `createLedgerXML`, `createBankLedgerXML`,
`createOdBankXML`, `getStockItemCreateXML`, `getStockItemOpeningXML`.

Voucher/invoice pushes were not found in these two files; they are likely built by the Python
generators in `src/python/` (not reviewed).
