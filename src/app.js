import express from "express";
import cors from "cors";

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

import groupSummarySC
from "./api/groupSummarySC.routes.js";

import groupSummarySD
from "./api/groupSummarySD.routes.js";

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

/* =================================
   NEW SALES ITEMS API
================================= */

import salesItemsRoutes
from "./api/salesItems.routes.js";

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
   GROUP SUMMARY APIs
================================= */

app.use(
  "/api/group-summary-cr",
  groupSummarySC
);

app.use(
  "/api/group-summary-dr",
  groupSummarySD
);

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

app.use(
  "/api",
  stockGroupSummaryRoute
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