import express from "express";
import cors from "cors";

/* =================================
   DAILY CRON
================================= */

import "./cron/dailySync.cron.js";
/* =================================
   SYNC WORKER
================================= */

import "./workers/sync.worker.js";





/* =================================
   WORKERS
================================= */

import "./workers/pushLedger.worker.js";

import "./workers/pushBank.worker.js";

import "./workers/pushOdBank.worker.js";


import "./workers/pushStockItem.worker.js";

import "./workers/pushInvoice.worker.js";




/* =================================

   ROUTES
================================= */

import db
from "./api/db.routes.js";

import companies
from "./api/companies.routes.js";

import ledgers
from "./api/ledgers.routes.js";

import syncRoutes
from "./api/sync.routes.js";

import parentGroupsRoutes
from "./api/parentGroups.routes.js";

import allParentGroupsRoutes
from "./api/allParentGroups.routes.js";


import groupSummaryBank
from "./api/groupSummaryBank.routes.js";

import ledgerVouchersRoutes
from "./api/ledgerVouchers.routes.js";

import payableDebtorsRoutes
from "./api/payableDebtors.routes.js";

import profitLossRoutes
from "./api/profitLoss.routes.js";

import stockGroupSummaryRoute
from "./api/stockGroupSummary.js";

import salesItemsRoutes
from "./api/salesItems.routes.js";

import pushLedgerRoutes
from "./api/pushLedger.routes.js";

import pushBankRoutes
from "./api/pushBank.routes.js";

import pushOdBankRoutes
from "./api/pushOdBank.routes.js";

import invoiceRoutes
from "./api/invoices.routes.js";
import unitsRoutes
from "./api/units.routes.js";

import pushStockItemRoutes
from "./api/pushStockItem.routes.js";

import allLedgerDetailsRoutes
from "./api/allLedgerDetails.routes.js";



/* =================================
   MIDDLEWARE
================================= */

import {
  loggerMiddleware
} from "./middleware/loggerMiddleware.js";

/* =================================
   EXPRESS APP
================================= */

const app = express();

/* =================================
   GLOBAL MIDDLEWARE
================================= */

app.use(cors());

app.use(express.json());

/* =================================
   LOGGER MIDDLEWARE
================================= */

app.use(
  loggerMiddleware
);

/* =================================
   DATABASE TEST API
================================= */

app.use(
  "/api/db",
  db
);

/* =================================
   COMPANY APIs
================================= */

app.use(
  "/api/companies",
  companies
);

/* =================================
   LEDGER APIs
================================= */

app.use(
  "/api/ledgers",
  ledgers
);

/* =================================
   SYNC APIs
================================= */

app.use(
  "/api/sync",
  syncRoutes
);

/* =================================
   GROUP SUMMARY BANK APIs
================================= */

app.use(
  "/api/group-summary-bank",
  groupSummaryBank
);

/* =================================
   LEDGER VOUCHER APIs
================================= */

app.use(
  "/api",
  ledgerVouchersRoutes
);

/* =================================
   PARENT GROUP APIs
================================= */

app.use(
  "/api",
  parentGroupsRoutes
);

app.use(
  "/api/all-parent-groups",
  allParentGroupsRoutes
);

/* =================================
   PAYABLE / DEBTOR APIs
================================= */

app.use(
  "/api",
  payableDebtorsRoutes
);

/* =================================
   PROFIT LOSS APIs
================================= */

app.use(
  "/api",
  profitLossRoutes
);

/* =================================
   SALES ITEMS APIs
================================= */

app.use(
  "/api",
  salesItemsRoutes
);

/* =================================
   STOCK GROUP SUMMARY APIs
================================= */

app.use(
  "/api",
  stockGroupSummaryRoute
);

/* =================================
   UNITS APIs
================================= */

app.use(
  "/api/units",
  unitsRoutes
);

/* =================================
   PUSH LEDGER APIs
================================= */

app.use(
  "/api",
  pushLedgerRoutes
);


app.use(
  "/api",
  pushBankRoutes
);

app.use(
  "/api",
  pushOdBankRoutes
);

app.use(
  "/api",
  invoiceRoutes
);

app.use(
  "/api",
  pushStockItemRoutes
);

app.use(
  "/api/all-ledger-details",
  allLedgerDetailsRoutes
);


/* =================================
   DEFAULT API
================================= */

app.get(

  "/",

  (req, res) => {

    return res.json({

      status: "success",

      message:
        "Tally Integration API Running"

    });

  }

);

/* =================================
   EXPORT APP
================================= */

export default app;
