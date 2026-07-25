import express from "express";
import cors from "cors";

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
import authRoutes from "./modules/auth/auth.routes.js";

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

app.use(
  cors({
    origin: [
      "http://100.117.199.124:5173", // Friend's frontend
      "http://localhost:5173",
      "http://localhost:3000"
    ],
    credentials: true,
  })
);

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
   STOCK ALERT APIs
================================= */

app.use(
  "/api",
  stockAlertRoutes
);

app.use(
  "/api",
  pullStockAlertRoutes
);
/* =================================
   PUSH LEDGER APIs
================================= */

app.use(
  "/api",
  pushLedgerRoutes
);
app.use("/auth", authRoutes);

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
  salesInvoiceRoutes
);

app.use(
  "/api",
  pushStockItemRoutes
);

app.use(
  "/api",
  pushStockItemOpeningRoutes
);

app.use(
  "/api/all-ledger-details",
  allLedgerDetailsRoutes
);

app.use(
  "/api",
  bulkStockItemRoutes
);

app.use(
  "/api",
  purchaseLedgerMappingRoutes
);

app.use(
  "/api",
  salesLedgerMappingRoutes
);

app.use(
  "/api",
  purchaseSalesLedgerRoutes
);

app.use(
  "/api",
  godownRoutes
);

app.use(
  "/api",
  bulkSalesUploadRoutes
);

app.use(
  "/api/connector",
  connectorRoutes
);

/* =================================
   VOUCHER APIs
================================= */
app.use(
  "/api/v1/voucher",
  voucherRoutes
);

app.use("/api/v1/sales", salesAccountRoutes);

app.use("/api/v1/purchase", purchaseAccountRoutes);

app.use("/api/v1/stock", stockInHandRoutes);

app.use("/api/v1/trends", trendsRouter);

app.use("/api/v1", topSalesLedgersRouter);

app.use("/api/v1", monthlySalesTrendRouter);

app.use("/api/v1/challan", challanRoutes);

app.use("/api/purchase-validation", purchaseValidationRoutes);


app.use(
  "/api/connector-auth",
  connectorAuthRoutes
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
