import express from "express";
import cors from "cors";
import supertokens from "supertokens-node";
import { middleware as supertokensMiddleware, errorHandler as supertokensErrorHandler } from "supertokens-node/framework/express/index.js";
import { initSupertokens } from "./config/supertokens.js";
import { requireSessionOrApiKey } from "./middleware/sessionOrApiKey.middleware.js";

initSupertokens();

/* =================================
   DAILY CRON
================================= */

import "./cron/dailySync.cron.js";





/* =================================
   WORKERS
================================= */

import "./workers/sync.worker.js";

import "./workers/pushLedger.worker.js";

import "./workers/pushBank.worker.js";

import "./workers/pushOdBank.worker.js";


import "./workers/pushStockItem.worker.js";

import "./workers/pushInvoice.worker.js";

import "./workers/pushSalesInvoice.worker.js";

import "./workers/pushAlterStockItem.worker.js";

import "./workers/stockAlert.worker.js";

import "./workers/bulkStockItem.worker.js";

import "./workers/bulkSales.worker.js";

import "./workers/pushVoucher.worker.js";

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

import salesInvoiceRoutes
from "./api/salesInvoices.routes.js";

import unitsRoutes
from "./api/units.routes.js";

import pushStockItemRoutes
from "./api/pushStockItem.routes.js";

import allLedgerDetailsRoutes
from "./api/allLedgerDetails.routes.js";

import pushStockItemOpeningRoutes
from "./api/pushStockItemOpening.routes.js";
import stockAlertRoutes
from "./api/stockAlert.routes.js";
import pullStockAlertRoutes
from "./api/pullStockAlert.routes.js";

import bulkStockItemRoutes
from "./api/bulkStockItem.routes.js";

import purchaseLedgerMappingRoutes
from "./api/purchaseLedgerMapping.routes.js";

import salesLedgerMappingRoutes
from "./api/salesLedgerMapping.routes.js";

import purchaseSalesLedgerRoutes
from "./api/purchaseSalesLedger.routes.js";

import godownRoutes
from "./api/godown.routes.js";

import bulkSalesUploadRoutes
 from "./api/bulkSalesUpload.routes.js";

 import connectorRoutes
from "./api/connector.routes.js";

import connectorAuthRoutes from "./api/connectorAuth.routes.js";

import voucherRoutes
 from "./api/voucher.routes.js";

import salesAccountRoutes
 from "./api/salesAccount.routes.js";

import purchaseAccountRoutes
 from "./api/purchaseAccount.routes.js";

import stockInHandRoutes
 from "./api/stockInHand.routes.js";

import trendsRouter
 from "./api/salesPurchaseTrend.routes.js";

import topSalesLedgersRouter
 from "./api/topSalesLedgers.js";

import monthlySalesTrendRouter
 from "./api/monthlySalesTrend.js";

import challanRoutes
 from "./api/challan.routes.js";

import purchaseValidationRoutes
 from "./api/purchaseValidation.routes.js";

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

const allowedOrigins = [
  "http://localhost:5173",
  "http://100.117.199.124:5173",   // add every Tailscale IP you test from
];

app.use(
  cors({
    origin: (origin, callback) => {
      // allow non-browser requests (curl, server-to-server) with no Origin header
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    allowedHeaders: ["content-type", ...supertokens.getAllCORSHeaders()],
    credentials: true,
  })
);

app.use(supertokensMiddleware());

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

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
  ...requireSessionOrApiKey(),
  db
);

/* =================================
   COMPANY APIs
================================= */

app.use(
  "/api/companies",
  ...requireSessionOrApiKey(),
  companies
);

/* =================================
   LEDGER APIs
================================= */

app.use(
  "/api/ledgers",
  ...requireSessionOrApiKey(),
  ledgers
);

/* =================================
   SYNC APIs
================================= */

app.use(
  "/api/sync",
  ...requireSessionOrApiKey(),
  syncRoutes
);

/* =================================
   GROUP SUMMARY BANK APIs
================================= */

app.use(
  "/api/group-summary-bank",
  ...requireSessionOrApiKey(),
  groupSummaryBank
);

/* =================================
   CONNECTOR APIs (desktop Tally connector — API-key auth, not
   SuperTokens sessions; see src/middleware/apiKey.middleware.js)

   Mounted here, ahead of the generic "/api" mounts below, since Express
   matches middleware by registration order — a generic "/api" gate mounted
   earlier would otherwise intercept and 401 these before they're ever
   reached, as "/api/connector-auth/..." also starts with "/api".
================================= */

app.use(
  "/api/connector",
  connectorRoutes
);

app.use(
  "/api/connector-auth",
  connectorAuthRoutes
);

/* =================================
   LEDGER VOUCHER APIs
================================= */

app.use(
  "/api",
  ...requireSessionOrApiKey(),
  ledgerVouchersRoutes
);

/* =================================
   PARENT GROUP APIs
================================= */

app.use(
  "/api",
  ...requireSessionOrApiKey(),
  parentGroupsRoutes
);

app.use(
  "/api/all-parent-groups",
  ...requireSessionOrApiKey(),
  allParentGroupsRoutes
);

/* =================================
   PAYABLE / DEBTOR APIs
================================= */

app.use(
  "/api",
  ...requireSessionOrApiKey(),
  payableDebtorsRoutes
);

/* =================================
   PROFIT LOSS APIs
================================= */

app.use(
  "/api",
  ...requireSessionOrApiKey(),
  profitLossRoutes
);

/* =================================
   SALES ITEMS APIs
================================= */

app.use(
  "/api",
  ...requireSessionOrApiKey(),
  salesItemsRoutes
);

/* =================================
   STOCK GROUP SUMMARY APIs
================================= */

app.use(
  "/api",
  ...requireSessionOrApiKey(),
  stockGroupSummaryRoute
);

/* =================================
   UNITS APIs
================================= */

app.use(
  "/api/units",
  ...requireSessionOrApiKey(),
  unitsRoutes
);

/* =================================
   STOCK ALERT APIs
================================= */

app.use(
  "/api",
  ...requireSessionOrApiKey(),
  stockAlertRoutes
);

app.use(
  "/api",
  ...requireSessionOrApiKey(),
  pullStockAlertRoutes
);
/* =================================
   PUSH LEDGER APIs
================================= */

app.use(
  "/api",
  ...requireSessionOrApiKey(),
  pushLedgerRoutes
);

app.use(
  "/api",
  ...requireSessionOrApiKey(),
  pushBankRoutes
);

app.use(
  "/api",
  ...requireSessionOrApiKey(),
  pushOdBankRoutes
);

app.use(
  "/api",
  ...requireSessionOrApiKey(),
  invoiceRoutes
);

app.use(
  "/api",
  ...requireSessionOrApiKey(),
  salesInvoiceRoutes
);

app.use(
  "/api",
  ...requireSessionOrApiKey(),
  pushStockItemRoutes
);

app.use(
  "/api",
  ...requireSessionOrApiKey(),
  pushStockItemOpeningRoutes
);

app.use(
  "/api/all-ledger-details",
  ...requireSessionOrApiKey(),
  allLedgerDetailsRoutes
);

app.use(
  "/api",
  ...requireSessionOrApiKey(),
  bulkStockItemRoutes
);

app.use(
  "/api",
  ...requireSessionOrApiKey(),
  purchaseLedgerMappingRoutes
);

app.use(
  "/api",
  ...requireSessionOrApiKey(),
  salesLedgerMappingRoutes
);

app.use(
  "/api",
  ...requireSessionOrApiKey(),
  purchaseSalesLedgerRoutes
);

app.use(
  "/api",
  ...requireSessionOrApiKey(),
  godownRoutes
);

app.use(
  "/api",
  ...requireSessionOrApiKey(),
  bulkSalesUploadRoutes
);

/* =================================
   VOUCHER APIs
================================= */
app.use(
  "/api/v1/voucher",
  ...requireSessionOrApiKey(),
  voucherRoutes
);

app.use("/api/v1/sales", ...requireSessionOrApiKey(), salesAccountRoutes);

app.use("/api/v1/purchase", ...requireSessionOrApiKey(), purchaseAccountRoutes);

app.use("/api/v1/stock", ...requireSessionOrApiKey(), stockInHandRoutes);

app.use("/api/v1/trends", ...requireSessionOrApiKey(), trendsRouter);

app.use("/api/v1", ...requireSessionOrApiKey(), topSalesLedgersRouter);

app.use("/api/v1", ...requireSessionOrApiKey(), monthlySalesTrendRouter);

app.use("/api/v1/challan", ...requireSessionOrApiKey(), challanRoutes);

app.use("/api/purchase-validation", ...requireSessionOrApiKey(), purchaseValidationRoutes);

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

app.use(supertokensErrorHandler());

/* =================================
   EXPORT APP
================================= */

export default app;
