# Tally XML Requests — Knowledge Transfer

Audience: new backend developer.
Scope: every XML request this backend builds and sends to Tally, what each one does, and where it is triggered.

---

## 1. Big picture

Tally Prime exposes an XML-over-HTTP interface (default `http://localhost:9000`). We talk to it in two directions:

| Direction | Tally verb | What it means | Where the XML is built |
|---|---|---|---|
| **Pull / Sync** (read from Tally into our DB) | `<TALLYREQUEST>Export</TALLYREQUEST>` (or `Export Data`) | "Give me data" | `src/services/xmlBuilder.js` |
| **Push** (write into Tally) | `<TALLYREQUEST>Import</TALLYREQUEST>` (or `Import Data`) | "Create/alter this record" | `src/services/pushXmlBuilder.js` (masters) and `src/python/*.py` (vouchers) |

### How the XML physically reaches Tally

The backend does **not** call Tally directly (it runs in the cloud; Tally runs on the customer's PC). Instead:

1. The backend builds the XML string.
2. It stores it as a **connector job** (`createConnectorJob` in `src/services/connectorJob.service.js`) — the XML goes in the `request_xml` column.
3. A **desktop connector** running next to Tally polls for jobs, POSTs the XML to `localhost:9000`, and returns Tally's response.
4. **Sync routes** wait for the answer with `sendToTallyViaConnector(companyId, xml, "sync", userId)` (`src/services/connectorSync.service.js` — polls every 250 ms, times out at 10 min). **Push workers** create the job and record its status asynchronously.

Only exception: `src/services/tallyHybrid.service.js` posts straight to `http://localhost:9000` (used for the cache → DB → Tally balance lookup).

Every job is scoped to `userId + companyId` via the user's connector pairing, so one user can never reach another user's Tally.

---

## 2. Anatomy of a Tally XML request (read this first)

Almost every request has the same skeleton. Once you understand it, all 30+ builders become variations.

```xml
<ENVELOPE>                                   <!-- root, always -->
  <HEADER>
    <VERSION>1</VERSION>                     <!-- protocol version, always 1 -->
    <TALLYREQUEST>Export</TALLYREQUEST>      <!-- Export = read, Import = write -->
    <TYPE>Collection</TYPE>                  <!-- Collection = list of objects; Object = one named object; Data = import -->
    <ID>List of Ledgers</ID>                 <!-- name of the collection/report/object to fetch -->
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>                      <!-- Tally "global settings" for this call -->
        <SVCURRENTCOMPANY>ABC Ltd</SVCURRENTCOMPANY>   <!-- which company is open/queried -->
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT> <!-- reply in XML -->
        <SVFROMDATE TYPE="Date">20250401</SVFROMDATE>  <!-- optional period -->
        <SVTODATE   TYPE="Date">20260331</SVTODATE>
      </STATICVARIABLES>
      <TDL>                                  <!-- inline TDL: define a collection on the fly -->
        <TDLMESSAGE>
          <COLLECTION NAME="List of Ledgers">
            <TYPE>Ledger</TYPE>              <!-- which Tally object type to list -->
            <FETCH>NAME</FETCH>              <!-- which fields to return -->
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
```

### Vocabulary cheat-sheet

| Tag | Meaning |
|---|---|
| `TYPE` = `Collection` | Return a list of objects (ledgers, vouchers, groups…). Defined by a `<COLLECTION>` in the TDL block. |
| `TYPE` = `Object` + `SUBTYPE` + `<ID TYPE="Name">` | Return **one** named object (e.g. one ledger, one group, the company). Uses `<FETCHLIST>`. |
| `TYPE` = `Data`, `ID` = `Vouchers` | Import request for vouchers. |
| `Export Data` + `<EXPORTDATA><REQUESTDESC><REPORTNAME>` | Run a built-in Tally **report** by name (Godown Summary, Profit and Loss). |
| `Import Data` + `<IMPORTDATA>` + `<REPORTNAME>All Masters` | Import masters (ledgers, stock items). |
| `SVCURRENTCOMPANY` | Company to run against. **Must match Tally's company name exactly.** |
| `SVEXPORTFORMAT $$SysName:XML` | Ask Tally to reply in XML (not text/HTML). |
| `SVFROMDATE` / `SVTODATE` | Period for voucher/P&L queries. Format `YYYYMMDD`. |
| `SVVCHIMPORTFORMAT XML` | Tells Tally the imported voucher data is XML. |
| `<FETCH>` | Field list to return for a collection (comma separated or repeated tag). `X.*` / `X.LIST` = "include the whole sub-list". |
| `<NATIVEMETHOD>` | Like FETCH but only real Tally-native fields (faster, no derived fields). |
| `<METHOD>Name:formula</METHOD>` | Defines a **computed field** (`Name`) from a TDL formula. |
| `<FILTERS>` / `<FILTER>` | Names a `<SYSTEM TYPE="Formulae">` that must be true for a row to be returned. |
| `<CHILDOF>` | Only rows whose group is under this group (used to list ledgers under Sundry Debtors etc.). |
| `<SYSTEM TYPE="Formulae" NAME="X">` | A named TDL boolean formula (e.g. `$Parent = "Sales Accounts"`). |
| `ACTION="Create"` / `"Alter"` | On imports: create a new record or modify an existing one. |
| `<TALLYMESSAGE xmlns:UDF="TallyUDF">` | Wrapper for each imported record. |
| `.LIST` suffix | A repeating sub-structure (e.g. `LEDGERENTRIES.LIST`, `RATEDETAILS.LIST`). |
| `&#4;` | Tally's internal marker for the `"Not Applicable"` / `Any` enum values (e.g. `&#4; Any`). Do not remove it. |
| `ISDEEMEDPOSITIVE` | Debit/credit direction flag on voucher entries (see §5.3 for sign rules). |

### Tally date and amount conventions
- Dates are always `YYYYMMDD` (e.g. `20260310`).
- Balances come back like `1234.50` (Dr) or `-1234.50` / `1234.50 Cr`; parsing is handled in the sync routes.
- Debit/Credit is encoded by **sign + ISDEEMEDPOSITIVE together**, not by either alone.

---

## 3. Pull requests (`src/services/xmlBuilder.js`)

All are `export const getXxxXML = (company, …) => \`…\``. They return a string; the calling route parses the reply (`fast-xml-parser` / `xml2js`) and upserts into Postgres (`app_test.*`).

### 3.1 Route → XML → table map

| # | Builder | Called from (`src/api/sync.routes.js`) | Purpose | Writes to |
|---|---|---|---|---|
| 1 | `getCompaniesXML()` | `GET /companies` | List companies open in Tally | `companies` |
| 2 | `getLedgersXML(company)` | `GET /ledgers` | List ledger **names only** (cheap first pass) | drives step 3 |
| 3 | `getLedgerDetailsXML(company, ledgerName)` | `GET /ledgers` (once per ledger) | Full detail (GSTIN, GUID, MasterID…) of one ledger | `ledgers` |
| 4 | `getGroupSummaryBankXML(company)` | `GET /group-summary-bank` | Bank ledgers with bank details, OD limit | `bank_accounts` |
| 5 | `getLedgerVouchersXML(company, from, to)` | `GET /voucher-sync` | All vouchers in a period with their ledger entries | `vouchers`, `sales_items` |
| 6 | `getSalesInvoiceDetailsXML(company, from, to)` | `GET /sales-invoice-details-sync` | Delivery / shipping / PO fields printed on sales invoices | updates voucher delivery details |
| 7 | `getParentGroupsXML(company)` | `GET /parent-groups` | Chart-of-accounts group tree | `parent_groups` |
| 8 | `getGroupBalanceXML(company, groupName)` | `GET /payable-debtors` | Opening/closing balance of one group (Sundry Debtors, Sundry Creditors, Stock-in-Hand) | `group_balances` |
| 9 | `getSalesGroupXML(company)` | `GET /payable-debtors` | Balance of the reserved "Sales Accounts" group | `group_balances` |
| 10 | `getPurchaseGroupXML(company)` | `GET /payable-debtors` | Balance of the reserved "Purchase Accounts" group | `group_balances` |
| 11 | `getAllParentGroupDetailsXML(company, group)` | `GET /all-parent-groups` | All ledgers under a given group | `all_parent_groups` |
| 12 | `getProfitLossXML(company, from, to)` | `GET /profit-loss-sync` | Closing balance of P&L groups | `profit_loss` |
| 13 | `getStockGroupSummaryXML(company)` | `GET /stock-group-summary-sync` | Stock **items** with qty, value, HSN, GST rates | `stock_group_summary` |
| 14 | `getStockGroupGSTXML(company)` | `GET /stock-group-gst-sync` | Stock **group**-level GST/HSN | `stock_group_gst_details` |
| 15 | `getUnitsXML(company)` | `GET /units-sync` | Simple units of measure (Nos, Kg…) | `units` |
| 16 | `getAllLedgersXML(company)` | `GET /all-ledgers-sync` | Every ledger with the full field set | `all_ledger_details` |
| 17 | `getPurchaseSalesLedgersXML(company)` | `GET /purchase-sales-ledgers-sync` | Ledgers under Purchase/Sales Accounts (used as dropdown for invoices) | `company_purchase_sales_ledgers` |
| 18 | `getGodownsXML(company)` | `GET /godown-sync` | Godown list (report-based) | `godown_details` |
| 19 | `getCompanyDetailsXML(company)` | `GET /company-details` (+ `companyDetails.routes.js`) | Company address, email, state, GST flags (for voucher PDFs) | `company_details` |
| 20 | `getCompanyGSTDetailsXML(company)` | `GET /company-details` | Company GSTIN via the Tax Unit collection | `company_details` |
| 21 | `getProfitLossReportXML(company)` | `syncProfitLossSummary()` in `profitLossSummarySync.service.js` (`GET /profit-loss-summary-sync`) | Runs Tally's actual "Profit and Loss" **report** and parses sales/purchase/stock/expense lines | `profit_loss_summary` |
| 22 | `getSalesVoucherExistsXML(company, refNo)` | `pushSalesInvoice.worker.js` | **Duplicate guard** before re-pushing a sales invoice | (read only) |
| — | `getStockInHandXML(company)` | *not referenced anywhere* | Stock-in-Hand group by name | dead code |
| — | `getGroupSummaryCRXML` / `getGroupSummaryDRXML` | *not referenced anywhere* | Sundry Creditors / Debtors ledger lists | dead code |

`GET /company-details` and `GET /payable-debtors` each fire several requests; `/ledgers` fires one list request plus N detail requests.

### 3.2 Line-by-line explanation of each request

Every request shares the skeleton in §2, so below only the parts that are **specific** to each builder are explained.

---

#### 1. `getCompaniesXML` — list companies
```
TYPE=Collection, ID=CompanyCollection
COLLECTION CompanyCollection → TYPE Company → FETCH NAME, BOOKSFROM, ENDINGAT
```
- No `SVCURRENTCOMPANY` — we are asking "which companies exist?", so no company can be selected yet.
- `BOOKSFROM` / `ENDINGAT` = financial year start / end of each company.
- This is the first call of the whole onboarding flow: sync companies → then everything else per company.

#### 2. `getLedgersXML` — ledger names
```
ID=List of Ledgers → TYPE Ledger → FETCH NAME
```
- Deliberately minimal (name only) so 10,000 ledgers return fast. `/ledgers` then loops over names and calls #3.

#### 3. `getLedgerDetailsXML` — one ledger in full
```
TYPE=Object, SUBTYPE=Ledger, <ID TYPE="Name">{ledgerName}</ID>
FETCHLIST: NAME, PARTYGSTIN, LEDGSTREGDETAILS.*, GUID, MASTERID, ALTERID
```
- `Object` request = one named object, so it uses `FETCHLIST` instead of a TDL collection.
- `LEDGSTREGDETAILS.*` returns the date-effective GST registration sub-list.
- `GUID / MASTERID / ALTERID` are Tally's identity fields. **`ALTERID` increments each time a record is edited** — this is what makes incremental sync/change-detection possible. The route passes the ledger name through an XML-escape (`xmlSafeName`) first.

#### 4. `getGroupSummaryBankXML` — bank ledgers
```
SYSTEM Formulae BankFilter: $Parent = "Bank OD A/c" OR $Parent = "Bank Accounts" ...
COLLECTION GroupSummaryBank → TYPE Ledger → FILTERS BankFilter → FETCH (large list)
```
- `FILTERS BankFilter` keeps only ledgers whose parent group is a bank group (normal bank + OD).
- The very long `FETCH` list is intentional: Tally uses **different internal names** for the same bank field depending on version/config (`BANKACNO`, `BANKACCOUNTNO`, `ACCOUNTNUMBER`, `BANKACNUMBER`…; `IFSCODE` vs `IFSCCODE`). We request all spellings and the parser takes whichever is populated.
- `ODLIMIT` = overdraft limit. `CONTACTDETAILS.*` returns the contact sub-list.
- (`"Bank Accounts"` appears twice in the formula — harmless duplicate.)

#### 5. `getLedgerVouchersXML` — vouchers in a date range
```
STATICVARIABLES: SVFROMDATE, SVTODATE (period)
COLLECTION LedgerVouchers ISMODIFY="No" → TYPE Voucher
FETCH: DATE, VOUCHERTYPENAME, VOUCHERNUMBER, PARTYLEDGERNAME, NARRATION, ALLLEDGERENTRIES.LIST
<DATA></DATA>
```
- `TYPE Voucher` — a voucher is any transaction (Sales, Purchase, Receipt, Payment, Journal, Contra…).
- `ALLLEDGERENTRIES.LIST` returns every debit/credit line of each voucher, which the route then splits into `vouchers` rows and `sales_items`.
- `ISMODIFY="No"` = we are defining a new collection, not modifying a built-in one.
- Empty `<DATA>` is required by some Tally versions for collection exports.

#### 6. `getSalesInvoiceDetailsXML` — delivery/shipping details of sales invoices
```
SYSTEM Formula SalesInvoiceDeliveryOnly: $$IsSales:$VoucherTypeName
COLLECTION SalesInvoiceDetails → TYPE Voucher → FILTER SalesInvoiceDeliveryOnly
NATIVEMETHOD: VoucherNumber, Date, PartyLedgerName, Reference, ReferenceDate, OtherReference,
              BasicDueDateOfPymt, BasicPurchaseOrderNo, BasicOrderDate, BasicShip* ...
```
- `$$IsSales:$VoucherTypeName` is true for **any voucher type whose base type is Sales** ("Sales GST", "Tax Invoice"…). A plain `= "Sales"` check returned nothing for companies with custom sales voucher types.
- The `Basic*` fields are the "Despatch / Order / Delivery details" block on the printed invoice.
- **`BasicDueDateOfPymt` is the field for "Mode/Terms of Payment"** (confirmed against live Tally). `BasicPaymentTerms` / `PaymentMode` are *not* real Tally methods and always come back blank.
- Uses `NATIVEMETHOD` (fast, real fields only).

#### 7. `getParentGroupsXML` — group tree
```
COLLECTION "Group Collection" → TYPE Group → FETCH Name, Parent, PrimaryGroup, IsRevenue, IsDeemedPositive
```
- `Parent` builds the hierarchy; `PrimaryGroup` is the top-level group it rolls up to; `IsRevenue` distinguishes P&L from balance-sheet groups; `IsDeemedPositive` says whether the group is naturally debit.

#### 8. `getGroupBalanceXML` — balance of one group
```
TYPE=Object, SUBTYPE=Group, <ID TYPE="Name">{groupName}</ID>
FETCHLIST: Name, Parent, ClosingBalance, OpeningBalance
```
- Single-object request for the group. Called for "Sundry Debtors", "Sundry Creditors", "Stock-in-Hand" (and a second time with "Stock in Hand" as the alternate spelling if the first returns empty).
- Results feed `group_balances`, which `GET /closing-balance` (`stockInHand.routes.js`) reads for the dashboard.

#### 9–10. `getSalesGroupXML` / `getPurchaseGroupXML`
```
SYSTEM Formulae: $$IsEqual:$ReservedName:"Sales Accounts"   (or "Purchase Accounts")
COLLECTION → TYPE Group → FILTERS → FETCH Name, ReservedName, Parent, Opening/ClosingBalance, GUID, MasterID, AlterID
```
- Uses `ReservedName` (Tally's immutable built-in name) so it still works if the user **renamed** the group in the UI.
- Returned as a *collection* (not an object) because of that reserved-name filter.

#### 11. `getAllParentGroupDetailsXML` — ledgers under a group
```
COLLECTION AllParentGroupDetails → TYPE Ledger → CHILDOF {groupName} → FETCH (address, GST, balances …)
```
- `CHILDOF` returns ledgers that sit anywhere **beneath** the group (including sub-groups), e.g. all Sundry Debtors.

#### 12. `getProfitLossXML` — P&L group balances
```
STATICVARIABLES: SVFROMDATE / SVTODATE
SYSTEM IsProfitLossGroup: $$IsEqual:$Name:"Sales Accounts" OR "Purchase Accounts" OR "Direct/Indirect Expenses/Incomes" OR "Stock-in-hand"
COLLECTION ProfitLossCollection → TYPE Group → FETCH Name, Parent, ClosingBalance
```
- Returns only the seven P&L-relevant groups for the period. Closing balance per group is then summed in code.

#### 13. `getStockGroupSummaryXML` — stock items with GST
```
SYSTEM formulae IsIGST / IsCGST / IsSGST / IsCess   (from GST_DUTY_HEAD_FORMULAE)
COLLECTION StockItemSummary → TYPE StockItem
NATIVEMETHOD Name, Parent, BaseUnits, ClosingBalance, ClosingValue
METHOD HSNCode, GSTRate, IGSTRate, CGSTRate, SGSTRate, CessRate, GSTApplicable   (from gstRateMethods)
```
- Despite the function name, it lists **StockItems** (name kept for history; the route is `/stock-group-summary-sync`).
- The `METHOD` lines are computed fields. Key facts (all confirmed live):
  - GST rates are read from `$GSTDetails[Last].StateWiseDetails[1].RateDetails[1,@@IsCGST].GSTRate` — i.e. *latest* GST slab → first state block → the rate row whose duty head matches the formula.
  - Duty-head values are the **short codes** `IGST`, `CGST`, `SGST/UTGST`, `Cess`. The long names ("Integrated Tax") never match and silently give blank rates.
  - **HSN lives in a separate list** `$HSNDetails[Last].HSNCode`, *not* inside `GSTDetails`.
- `ISMODIFY/ISFIXED/ISINITIALIZE…` attributes are Tally boilerplate for a fresh custom collection.

#### 14. `getStockGroupGSTXML` — stock **group** GST
- Identical to #13 but `TYPE StockGroup` and `gstRateMethods("StockGroup")`. Reason: a business can set GST at group level; items with no GST of their own inherit from the group.

#### 15. `getUnitsXML` — units of measure
```
COLLECTION TSPLSimpleUnits → TYPE Unit → NATIVEMETHOD Name, OriginalName, IsSimpleUnit → FILTERS $IsSimpleUnit
```
- Only *simple* units (Nos, Kg), excluding compound units like "Box of 12 Nos".
- Note: this one sets `SVEXPORTFORMAT` to plain `XML` (others use `$$SysName:XML`) — both work.

#### 16. `getAllLedgersXML` — every ledger, every field
- Same field set as the Sundry Creditors summary: address, contact, GST (`PARTYGSTIN`, `LEDGSTREGDETAILS.*`), PAN (`INCOMETAXNUMBER`), bank, credit period/limit, balances, GUID/MASTERID/ALTERID.
- Many phone/mobile/state fields have multiple spellings for the same reason as #4.

#### 17. `getPurchaseSalesLedgersXML` — ledgers usable for purchase/sales lines
```
SYSTEM IsPurchaseOrSales: $Parent = "Purchase Accounts" OR $Parent = "Sales Accounts"
COLLECTION → TYPE Ledger → FILTER → FETCH NAME, PARENT, MASTERID, ALTERID, GUID
```
- Powers the "choose purchase/sales ledger" dropdown when pushing invoices.

#### 18. `getGodownsXML` — godowns (report style)
```
TALLYREQUEST = "Export Data"; EXPORTDATA → REQUESTDESC → REPORTNAME "Godown Summary"
```
- The only master list fetched by running a **built-in report** rather than defining a collection. Different envelope shape: no `VERSION/TYPE/ID`, and settings sit inside `REQUESTDESC`.

#### 19. `getCompanyDetailsXML` — company master
```
TYPE=Object, SUBTYPE=Company, <ID TYPE="Name">{company}</ID>
FETCHLIST: NAME, ADDRESS, EMAIL, STATENAME, ISGSTON, GSTREGISTRATIONTYPE
```
- Used to print company header/address on voucher PDFs.

#### 20. `getCompanyGSTDetailsXML` — company GSTIN
```
COLLECTION TaxUnitCollection → TYPE "Tax Unit" → FETCH NAME, GSTREGNUMBER, GSTREGISTRATIONDETAILS.LIST
```
- The company's GSTIN is on the *Tax Unit*, not on the Company object, hence a separate request.
- `src/utils/tally.js` has a fully commented-out helper that used this to cache the GSTIN + derive state code; it is currently disabled.

#### 21. `getProfitLossReportXML` — actual P&L report
```
TALLYREQUEST "Export Data" → REPORTNAME "Profit and Loss"
```
- Runs the same report a user sees on screen, then `parseProfitLossReport()` extracts sales, opening stock, purchases, direct expenses, closing stock, indirect income/expenses, and net result. Gross profit and margin % are calculated in code (`profitLossSummarySync.service.js`).
- Reply containing `<ERRORMSG>` or `Unknown Request` is treated as failure.
- The route passes `(company, from, to)` but the builder currently accepts only `company` — the date range is **not** applied by this XML (Tally uses the company's current period). Worth knowing if numbers look off.

#### 22. `getSalesVoucherExistsXML` — duplicate guard
```
SYSTEM RefMatch: $VoucherTypeName = "Sales" AND $Reference = "{referenceNo}"
COLLECTION SalesRefCheck → TYPE Voucher → FILTERS RefMatch → FETCH VOUCHERNUMBER, REFERENCE, DATE
```
- Before **retrying** a failed sales push, we ask Tally "does a Sales voucher with this reference already exist?". Reason: a previous attempt may have actually succeeded but not been recorded on our side. Tally silently rejects duplicates (`CREATED=0 ALTERED=0 EXCEPTIONS=1`, no `LINEERROR`), so without this check we'd mark good invoices as failed.
- ⚠ `referenceNo` is interpolated **without XML escaping** (see §7).

---

## 4. Push requests for masters (`src/services/pushXmlBuilder.js`)

All wrap the same import skeleton:

```xml
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>          <!-- target: masters import -->
        <STATICVARIABLES><SVCURRENTCOMPANY>…</SVCURRENTCOMPANY></STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER|STOCKITEM NAME="…" ACTION="Create|Alter"> … </LEDGER|STOCKITEM>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>
```

Helpers: `safe()` (escapes `& < > "`, trims) and `escapeXml()` (also escapes `'`). **All user text must go through one of these** or an `&` in a name breaks the request.

| Builder | Worker | Purpose |
|---|---|---|
| `createLedgerXML(data)` | `pushLedger.worker.js` | Create a party/general ledger |
| `createBankLedgerXML(data)` | `pushBank.worker.js` | Create a bank account ledger |
| `createOdBankXML(data)` | `pushOdBank.worker.js` | Create an OD / OCC bank ledger |
| `getStockItemCreateXML(opts)` | `pushStockItem.worker.js` | Create a stock item with GST/HSN |
| `getStockItemOpeningXML(opts)` | `pushAlterStockItem.worker.js` | **Alter** an existing stock item to set its opening stock |

### 4.1 `createLedgerXML` — walk-through
| XML part | Explanation |
|---|---|
| `<LEDGER NAME=… RESERVEDNAME="" ACTION="Create">` | New ledger; `RESERVEDNAME` blank because it's a user ledger, not a built-in. |
| `NAME`, `MAILINGNAME` | Ledger name; mailing name defaults to the same. |
| `PARENT` | Group the ledger belongs to (Sundry Debtors/Creditors…). Must already exist in Tally. |
| `OPENINGBALANCE` | Defaults to 0. |
| `ISBILLWISEON` | "Yes" unless caller sent `bill_wise = "No"` (bill-by-bill tracking). |
| `LEDMAILINGDETAILS.LIST` | Address block: `ADDRESS.LIST`, `PINCODE`, `STATE`, `COUNTRY` (default India), contact person, mobile, email. `APPLICABLEFROM 20250401` is the date the details take effect. |
| `LEDSTATENAME`, `LEDCOUNTRYNAME`, `LEDPINCODE`, `LEDGERCONTACT`, `LEDGERPHONE`, `LEDGERMOBILE`, `LEDGERWEBSITE` | Duplicate flat fields — Tally reads some screens from these instead of the mailing list, so both are sent. |
| `INCOMETAXNUMBER` | PAN. |
| `ISGSTAPPLICABLE` = Yes, `GSTREGISTRATIONTYPE` (default Regular), `PARTYGSTIN`, `PLACEOFSUPPLY` | GST identity. |
| `GSTDETAILS.LIST` and `LEDGSTREGDETAILS.LIST` | Date-effective GST records (taxability, registration type, GSTIN, state). Two lists because two different Tally screens read them. |
| `LANGUAGENAME.LIST` (`LANGUAGEID 1033`) | English (US) display name — required for Tally to show the name. |

### 4.2 `createBankLedgerXML` — differences from a normal ledger
- `PARENT` defaults to **Bank Accounts**; `ISBILLWISEON = No`.
- Banking flags: `ISBANKINGLEDGER`, `ISCHEQUEPRINTINGENABLED`, `ISPAYUPLOAD` all Yes.
- `BANKNAME`, `BANKBRANCHNAME` plus `IFSCCODE` **and** `IFSCODE` (both spellings sent).
- `BANKALLOCATIONS.LIST` holds the account: `BANKACCHOLDERNAME`, `BANKDETAILS` (= account number), `BANKIFSC`, `SWIFTCODE`, `BANKIBAN`.

### 4.3 `createOdBankXML` — OD / OCC accounts
- `account_type === "OCC"` → parent **Bank OCC A/c**, otherwise **Bank OD A/c**.
- `ISODACCOUNT` and `ISLOANACCOUNT` = Yes only for OD.
- `ODLIMIT` and `SETODLIMIT` both set from `od_limit` (Tally needs both).
- `ISINTERESTON = No`.
- Bank allocation additionally sets `SETASDEFAULTACCT` and `ISDEFAULTBANK` = Yes.
- (Migration `20260908000000_add_od_limit_to_bank_accounts.js` added the `od_limit` column.)

### 4.4 `getStockItemCreateXML` — stock item
| XML part | Explanation |
|---|---|
| `<STOCKITEM NAME=… ACTION="Create">` | New item. |
| `PARENT` | Stock group; emits `<PARENT/>` (empty = Primary) if none supplied. |
| `GSTAPPLICABLE` = `&#4; Applicable` / `&#4; Not Applicable` | Enum value with Tally's `&#4;` marker. Anything other than the literal string `"Applicable"` becomes Not Applicable. |
| `GSTTYPEOFSUPPLY` Goods, `COSTINGMETHOD` Avg. Cost, `VALUATIONMETHOD` Avg. Price | Hard-coded defaults. |
| `BASEUNITS` | Unit (must already exist — see units sync). |
| `ISBATCHWISEON / ISPERISHABLEON / ISCOSTCENTRESON / IGNORENEGATIVESTOCK` | All No. |
| `GSTDETAILS.LIST` (only when GST applicable) | `APPLICABLEFROM` (default `20250401`), `TAXABILITY Taxable`, then `STATEWISEDETAILS.LIST` for state "Any" containing four `RATEDETAILS.LIST` rows: CGST, SGST/UTGST, IGST (each `Based on Value` with the given rate) and Cess / State Cess (not applicable). |
| `HSNDETAILS.LIST` | Separate date-effective list holding `HSNCODE`. |
| `LANGUAGENAME.LIST` | Item name and (optional) alias — an alias is just a second `<NAME>`. |

### 4.5 `getStockItemOpeningXML` — set opening stock
- `ACTION="Alter"`: modifies an item that already exists (created earlier by 4.4).
- `OPENINGBALANCE` = `"{qty} {unit}"`, `OPENINGRATE` = `"{rate}/{unit}"`, `OPENINGVALUE` = value.
- Kept as a separate step because Tally opening stock is best set after the item exists.

---

## 5. Push requests for vouchers (Python generators)

Vouchers are built in Python with `xml.etree.ElementTree` (not string templates). Node spawns `python`, writes JSON to **stdin**, reads XML from **stdout** (UTF-8 explicitly — Windows defaults break non-ASCII item names).

| Generator | Voucher | Triggered by |
|---|---|---|
| `src/python/generator.py` | **Purchase** | `pushInvoice.worker.js` → `generateXmlViaQueue("purchase", …)` (also bulk purchase) |
| `src/python/sales_generator.py` | **Sales** | `pushSalesInvoice.worker.js` → `generateXmlViaQueue("sales", …)` (also bulk sales) |
| `src/python/VoucherGenerator.py` | **Payment / Receipt / Contra / Journal** (accounting vouchers) | `pushVoucher.worker.js` (spawns it directly, payload as argv JSON) |

### 5.1 Why there is an "XML generation queue"
`src/queues/xmlGeneration.queue.js` + `src/workers/xmlGeneration.worker.js` (concurrency **1**) exist because many concurrent `python.exe` spawns caused access-violation crashes on Windows. All purchase/sales XML generation is funnelled through this single low-concurrency queue; callers use `generateXmlViaQueue(type, data)` and await the XML string (120 s timeout). `xmlGenerator.js` holds `generateXml` (purchase) and `generateSalesXml`. (`salesXmlGenerator.js` is a near-duplicate of `generateSalesXml` using an absolute script path.)

### 5.2 Voucher import envelope
```xml
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Import</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>Vouchers</ID>
  </HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVVCHIMPORTFORMAT>XML</SVVCHIMPORTFORMAT>
      <SVCURRENTCOMPANY>…</SVCURRENTCOMPANY>
    </STATICVARIABLES>
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER VCHTYPE="Purchase|Sales" ACTION="Create"> … </VOUCHER>
    </TALLYMESSAGE>
  </DESC></BODY>
</ENVELOPE>
```
(`VoucherGenerator.py` places `TALLYMESSAGE` under `BODY/DATA` and adds `OBJVIEW="Accounting Voucher View"`. Both shapes are accepted by Tally today — don't "unify" them without testing against a real Tally.)

### 5.3 Purchase voucher (`generator.py`) — field by field

**Header fields (children of `<VOUCHER>`)**

| Tag | Source / meaning |
|---|---|
| `DATE`, `VCHSTATUSDATE` | `invoice_date` normalised to `YYYYMMDD` by `parse_date()` (accepts `DD-MM-YYYY`, `YYYY-MM-DD`, `DD/MM/YYYY`, or already 8 digits). |
| `REFERENCEDATE` | `reference_date` or invoice date — the vendor's invoice date. |
| `VOUCHERTYPENAME` = Purchase | Voucher type. |
| `VOUCHERNUMBER` | **Deliberately not sent** (commented out) → Tally auto-numbers. |
| `REFERENCE` | Vendor's invoice number (`reference`, else `invoice_no`). |
| `PARTYNAME`, `PARTYLEDGERNAME` | Vendor ledger name. |
| `PARTYGSTIN`, `STATENAME`, `COUNTRYOFRESIDENCE`, `PLACEOFSUPPLY` | Only emitted if known. State is resolved: explicit state → **first 2 digits of GSTIN via `GST_STATE_MAP`** → GSTIN stored on the Tally ledger (`ledger_gstin`). Place of supply defaults to party state. |
| `ISINVOICE` = Yes | Item-invoice mode (inventory voucher) instead of accounting-only. |
| `NARRATION` | Given, or auto: "Being purchase from X vide invoice N dated D". |

**Inventory lines** — one `ALLINVENTORYENTRIES.LIST` per line item:
`STOCKITEMNAME`, `ISDEEMEDPOSITIVE=Yes`, `RATE "{rate}/{unit}"`, `AMOUNT -amount`, `ACTUALQTY` and `BILLEDQTY "{qty} {unit}"`, optional `GODOWNNAME`, and nested `ACCOUNTINGALLOCATIONS.LIST` (`LEDGERNAME` = purchase ledger, `ISDEEMEDPOSITIVE=Yes`, `AMOUNT -amount`).

**Ledger entries** — `LEDGERENTRIES.LIST`:
| Entry | ISDEEMEDPOSITIVE | Amount |
|---|---|---|
| Party (vendor, `ISPARTYLEDGER=Yes`) | No (credit) | `+grand_total` |
| CGST / SGST / IGST (only if > 0) | Yes (debit) | `-amount` |
| TDS, Cess (only if > 0 and ledger name given) | Yes | `-amount` |
| Round-off (only if `|diff| ≥ 0.01`) | Yes | `-round_off` |

`round_off = grand_total − (items + CGST + SGST + IGST)`.

### 5.4 Sales voucher (`sales_generator.py`) — differences from purchase
- `VCHTYPE="Sales"`, defaults for ledger names (`Sales`, `CGST`, `SGST`, `IGST`, `Round Off`).
- **Signs are mirrored**: items `ISDEEMEDPOSITIVE=No` with positive amounts; party ledger `ISDEEMEDPOSITIVE=yes` with **negative** `grand_total` (the customer is debited); GST ledgers positive; TDS negative; Cess positive. `abs()` is applied to incoming amounts so `+100` and `-100` both work.
- Extra header fields: `GSTREGISTRATIONTYPE` (**Regular** if GSTIN present, else **Unregistered/Consumer**), and Consignee mirrors (`CONSIGNEEGSTIN`, `CONSIGNEESTATENAME`, `CONSIGNEECOUNTRYNAME`).
- State cleanup: bulk sources sometimes send a raw numeric state **code** (`"23"`); it is mapped through `GST_STATE_MAP` for both State and Place of Supply.
- `BASICUSERDESCRIPTION.LIST` (item description) is written **before** `STOCKITEMNAME` — that is the order Tally itself exports.
- **Line amounts are rounded per item first, then summed** so the voucher total matches exactly what is written (a previous sum-then-round approach created 1-paisa unbalanced vouchers).
- **Round-off is validated, not trusted**: if the incoming `round_off` doesn't balance the voucher, it's overridden with the computed remainder and a warning is logged. Reason: unbalanced vouchers are accepted by Tally on import, then flagged later under *"Mismatch in total amount between Credit and Debit entries"*, and every retry creates another broken duplicate.
- Round-off entry uses `ISDEEMEDPOSITIVE=No` and lets the signed amount carry direction (`Yes` made Tally display a positive round-off as "(-)0.38").
- `INVOICEDELNOTES.LIST` — one per delivery challan (`BASICSHIPDELIVERYNOTE` = challan no., `BASICSHIPPINGDATE` = date). No limit on count.
- Exits with an error if the date can't be parsed.
- ⚠ It also writes `sales_debug.xml` into the process working directory on every run (debug leftover).

### 5.5 Accounting vouchers (`VoucherGenerator.py`)
Used for Payment / Receipt / Contra / Journal.
- `VCHTYPE` = capitalised `voucher_type`; `OBJVIEW="Accounting Voucher View"` = plain accounting entry screen (no inventory).
- Header: `DATE`, `VOUCHERTYPENAME`, `VOUCHERNUMBER` (**we supply the number here** — `pushVoucher.worker.js` passes `voucher_number` from the voucher row), `PARTYLEDGERNAME`, `NARRATION`.
- One `ALLLEDGERENTRIES.LIST` per ledger: `LEDGERNAME`, `ISDEEMEDPOSITIVE` (from `is_positive`), `ISPARTYLEDGER`, `AMOUNT`.
- If a ledger has `bank_allocation`, a nested `BANKALLOCATIONS.LIST` is added: `DATE`, `INSTRUMENTDATE`, `TRANSACTIONTYPE` (default `Cheque/DD`), `BANKNAME`, `PAYMENTFAVOURING`, `INSTRUMENTNUMBER`, `PAYMENTMODE` (default `Transacted`), `BANKPARTYNAME`, `ISCONNECTEDPAYMENT No`, `AMOUNT`.
- The worker's `buildLedgers()` (`pushVoucher.worker.js`) decides which ledgers/signs to send.

---

## 6. End-to-end examples

**Sync (pull) — e.g. ledgers**
`GET /api/sync/ledgers` → `requireUser` → `getLedgersXML(company)` → `sendToTallyViaConnector` (job → connector → Tally) → parse names → for each name `getLedgerDetailsXML` → upsert DB.

**Push (write) — e.g. a ledger**
UI saves row in `push_ledger` → job enqueued (BullMQ `ledger.queue.js`) → `pushLedger.worker.js` → `createLedgerXML()` → resolve connector for company/user → `createConnectorJob({jobType:"ledger", requestXml})` → status `pending` → connector posts to Tally and reports back → status updated.

**Push — a sales invoice**
`pushSalesInvoice.worker.js` → (retry only) `getSalesVoucherExistsXML` guard → `generateXmlViaQueue("sales", invoiceData)` → `sales_generator.py` → XML → `createConnectorJob` → connector → Tally.

---

## 7. Gotchas and known rough edges (please read before changing anything)

1. **Escaping is inconsistent.** Push builders escape values (`safe` / `escapeXml`). Most **pull** builders interpolate `${company}` / `${ledgerName}` / `${referenceNo}` raw, so a company like `A & B Traders` produces invalid XML. Only `/ledgers` pre-escapes the ledger name. Consider escaping in one place.
2. **Whitespace inside tags is tolerated.** Many templates put values on their own line (`<SVCURRENTCOMPANY>\n ${company}\n</…>`); Tally trims it. Don't rely on it for attribute values.
3. **Field-name spelling varies across Tally versions** (bank account number, IFSC, phone). That is why FETCH lists look redundant.
4. **Confirmed-live findings** are documented in code comments (GST duty-head codes, HSN list path, `BasicDueDateOfPymt`, `$$IsSales`). Don't "clean these up" from documentation alone — Tally's documented names differ from real behaviour.
5. **Dead code:** `getGroupSummaryCRXML`, `getGroupSummaryDRXML`, `getStockInHandXML` are exported but never imported. `src/utils/tally.js` is entirely commented out. `salesXmlGenerator.js` duplicates `generateSalesXml`.
6. **Duplicate voucher = silent failure.** Tally reports `CREATED=0 ALTERED=0 EXCEPTIONS=1` with no `LINEERROR`. Use `getSalesVoucherExistsXML` before retrying.
7. **Unbalanced vouchers import successfully** and only surface later in Tally's "Mismatch" report — that's why the sales generator forces the round-off to balance.
8. **`getProfitLossReportXML` takes only `company`**, while its caller passes dates.
9. **Hard-coded dates:** master pushes default `APPLICABLEFROM` to `20250401`, and `createLedgerXML` always uses it. Revisit each financial year.
10. **Python must be on PATH** on the server (`spawn("python", …)`), and `xmlGenerator.js` uses the relative path `src/python/...`, so the process must start from the backend root.
11. **Sample XML files** in the backend root (`ok.xml`, `test.xml`, `Sales_26-27_06_1.xml`) are real Tally exports/imports useful as references for expected shapes.

---

## 8. Suggested learning path for a new joiner
1. Read §2, then open `getCompaniesXML` and `getLedgersXML` — the simplest requests.
2. Open a Tally instance, enable the XML server (port 9000), and POST those two with Postman/curl to see raw replies.
3. Read `getLedgerVouchersXML` + `/voucher-sync` to see collection → DB.
4. Read `createLedgerXML` and one push worker to see the push lifecycle.
5. Finish with `sales_generator.py` — it contains the most hard-won business rules (rounding, signs, GST state mapping).
