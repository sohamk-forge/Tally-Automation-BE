import express from "express";
import cors from "cors";
import supertokens from "supertokens-node";
import { middleware as supertokensMiddleware, errorHandler as supertokensErrorHandler } from "supertokens-node/framework/express/index.js";
import { initSupertokens } from "./config/supertokens.js";
import { requireSessionOrApiKey } from "./middleware/sessionOrApiKey.middleware.js";
import { requireCompanyAccess } from "./middleware/companyAccess.middleware.js";

// Auth + tenant guard: every company_id / companyId / x-company-id /
// company name on the request must belong to the caller (see
// companyAccess.middleware.js). Routers that check access themselves are
// on its skip list.
const requireSessionAndCompany = () => [...requireSessionOrApiKey(), requireCompanyAccess];
import { isQuietRoute } from "./utils/quietRoutes.js";

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

import "./workers/xmlGeneration.worker.js";

import "./workers/pushInvoice.worker.js";

import "./workers/pushSalesInvoice.worker.js";

import "./workers/pushAlterStockItem.worker.js";

import "./workers/stockAlert.worker.js";

import "./workers/bulkStockItem.worker.js";

import "./workers/bulkSales.worker.js";

import "./workers/pushVoucher.worker.js";

import "./workers/bulkSalesV2.worker.js";

import "./workers/bulkPurchase.worker.js";

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

import bankInterestRoutes
from "./api/bankInterest.routes.js";

import payableDebtorsRoutes
from "./api/payableDebtors.routes.js";

import profitLossRoutes
from "./api/profitLoss.routes.js";

import stockGroupSummaryRoute
from "./api/stockGroupSummary.js";

import salesItemsRoutes
from "./api/salesItems.routes.js";

import invoiceCalculationRoutes
from "./api/invoiceCalculation.routes.js";

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

import bulkPurchaseUploadRoutes
from "./api/bulkPurchaseUpload.routes.js";

import vendorGstinMappingRoutes
from "./api/vendorGstinMapping.routes.js";

 import connectorRoutes
from "./api/connector.routes.js";
import {
  connectorInstallerLinkRouter,
  connectorInstallerDownloadRouter
} from "./api/connectorInstaller.routes.js";

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

import voucherPdfRoutes from "./api/voucherPdf.routes.js";


import invitesRoutes
 from "./api/invites.routes.js";

import accountRoutes
 from "./api/account.routes.js";

import challanPdfRoutes from "./api/challanpdf.routes.js";
import quotationRoutes from "./api/quotation.routes.js";
import quotationPdfRoutes from "./api/quotationpdf.routes.js";


import companyLogoRoutes
from "./api/companyLogo.routes.js";

import bulkSalesV2Routes from "./api/bulkSalesV2.routes.js";

import proformaRoutes from "./api/proforma.routes.js";

import deliveryPersonRoutes from "./api/delivery-person.routes.js";
import siteRoutes from "./api/site.routes.js";

import userRoutes from "./api/user.routes.js";

import gstAuthRoutes from "./api/gstAuth.routes.js";

import emailVerificationRoutes from "./api/emailVerification.routes.js";

import gstReturnStatusRoutes from "./api/gstReturnStatus.routes.js";

import ledgerPdfRoutes from "./api/ledgerPdf.routes.js";
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
  "http://100.117.199.124:5173",
  "http://192.168.0.7:5173",
  "http://100.91.212.45:5173",  // add every Tailscale IP you test from
  "http://103.215.115.12:5173",
];

// Logs every incoming request before anything else touches it — including
// /auth/* routes, which supertokensMiddleware() handles internally and
// never passes through to loggerMiddleware() further down the chain.
app.use((req, res, next) => {
  if (!isQuietRoute(req)) {
    console.log(`➡️  ${req.method} ${req.originalUrl} from origin=${req.headers.origin || "none"}`);
  }
  next();
});

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
    // Required for header-based session tokens: without this, the browser
    // hides SuperTokens' response headers (st-access-token, etc.) from the
    // frontend SDK even though they're present at the HTTP level.
    exposedHeaders: supertokens.getAllCORSHeaders(),
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
   CONNECTOR INSTALLER DOWNLOAD
   /link verifies the session itself; /download/:token is public on purpose
   (a plain browser navigation can't carry the session header) — the
   single-use, 60s token is what authorises it.
   Must stay above the app.use("/api", requireSessionOrApiKey()) mounts
   below, which would otherwise reject the token URL before it is reached.
================================= */
app.use("/api/connector-installer", connectorInstallerLinkRouter);
app.use("/api/connector-installer", connectorInstallerDownloadRouter);

/* =================================
   DATABASE TEST API
================================= */

app.use(
  "/api/db",
  ...requireSessionAndCompany(),
  db
);

/* =================================
   COMPANY APIs
================================= */

app.use(
  "/api/companies",
  ...requireSessionAndCompany(),
  companies
);

/* =================================
   LEDGER APIs
================================= */

app.use(
  "/api/ledgers",
  ...requireSessionAndCompany(),
  ledgers
);

/* =================================
   SYNC APIs
================================= */

app.use(
  "/api/sync",
  ...requireSessionAndCompany(),
  syncRoutes
);

/* =================================
   GROUP SUMMARY BANK APIs
================================= */

app.use(
  "/api/group-summary-bank",
  ...requireSessionAndCompany(),
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
  ...requireSessionAndCompany(),
  ledgerVouchersRoutes
);

/* =================================
   BANK INTEREST APIs
================================= */

app.use(
  "/api",
  ...requireSessionAndCompany(),
  bankInterestRoutes
);

/* =================================
   PARENT GROUP APIs
================================= */

app.use(
  "/api",
  ...requireSessionAndCompany(),
  parentGroupsRoutes
);

app.use(
  "/api/all-parent-groups",
  ...requireSessionAndCompany(),
  allParentGroupsRoutes
);

/* =================================
   PAYABLE / DEBTOR APIs
================================= */

app.use(
  "/api",
  ...requireSessionAndCompany(),
  payableDebtorsRoutes
);

/* =================================
   PROFIT LOSS APIs
================================= */

app.use(
  "/api",
  ...requireSessionAndCompany(),
  profitLossRoutes
);

/* =================================
   SALES ITEMS APIs
================================= */

app.use(
  "/api",
  ...requireSessionAndCompany(),
  salesItemsRoutes
);

/* =================================
   STOCK GROUP SUMMARY APIs
================================= */

app.use(
  "/api",
  ...requireSessionAndCompany(),
  stockGroupSummaryRoute
);

/* =================================
   INVOICE / STOCK ITEM CALCULATION API
================================= */

app.use(
  "/api",
  ...requireSessionAndCompany(),
  invoiceCalculationRoutes
);

/* =================================
   UNITS APIs
================================= */

app.use(
  "/api/units",
  ...requireSessionAndCompany(),
  unitsRoutes
);

/* =================================
   STOCK ALERT APIs
================================= */

app.use(
  "/api",
  ...requireSessionAndCompany(),
  stockAlertRoutes
);

app.use(
  "/api",
  ...requireSessionAndCompany(),
  pullStockAlertRoutes
);
/* =================================
   PUSH LEDGER APIs
================================= */

app.use(
  "/api",
  ...requireSessionAndCompany(),
  pushLedgerRoutes
);

app.use(
  "/api",
  ...requireSessionAndCompany(),
  pushBankRoutes
);

app.use(
  "/api",
  ...requireSessionAndCompany(),
  pushOdBankRoutes
);

app.use(
  "/api",
  ...requireSessionAndCompany(),
  invoiceRoutes
);

app.use(
  "/api",
  ...requireSessionAndCompany(),
  salesInvoiceRoutes
);

app.use(
  "/api",
  ...requireSessionAndCompany(),
  pushStockItemRoutes
);

app.use(
  "/api",
  ...requireSessionAndCompany(),
  pushStockItemOpeningRoutes
);

app.use(
  "/api/all-ledger-details",
  ...requireSessionAndCompany(),
  allLedgerDetailsRoutes
);

app.use(
  "/api",
  ...requireSessionAndCompany(),
  bulkStockItemRoutes
);

app.use(
  "/api",
  ...requireSessionAndCompany(),
  purchaseLedgerMappingRoutes
);

app.use(
  "/api",
  ...requireSessionAndCompany(),
  salesLedgerMappingRoutes
);

app.use(
  "/api",
  ...requireSessionAndCompany(),
  purchaseSalesLedgerRoutes
);

app.use(
  "/api",
  ...requireSessionAndCompany(),
  godownRoutes
);

app.use(
  "/api",
  ...requireSessionAndCompany(),
  bulkSalesUploadRoutes
);

app.use(
  "/api",
  ...requireSessionAndCompany(),
  bulkPurchaseUploadRoutes
);

app.use(
  "/api",
  ...requireSessionAndCompany(),
  vendorGstinMappingRoutes
);

/* =================================
   VOUCHER APIs
================================= */
app.use("/api/v1/voucher", ...requireSessionAndCompany(), voucherRoutes);

app.use("/api/v1/sales", ...requireSessionAndCompany(), salesAccountRoutes);

app.use("/api/v1/purchase", ...requireSessionAndCompany(), purchaseAccountRoutes);

app.use("/api/v1/stock", ...requireSessionAndCompany(), stockInHandRoutes);

app.use("/api/v1/trends", ...requireSessionAndCompany(), trendsRouter);

app.use("/api/v1", ...requireSessionAndCompany(), topSalesLedgersRouter);

app.use("/api/v1", ...requireSessionAndCompany(), monthlySalesTrendRouter);

app.use("/api/v1/challan", ...requireSessionAndCompany(), challanRoutes);

app.use("/api/purchase-validation", ...requireSessionAndCompany(), purchaseValidationRoutes);

app.use(
  "/api/v1/voucher",
  ...requireSessionAndCompany(),
  voucherPdfRoutes
);

app.use("/api/v1/proforma", ...requireSessionAndCompany(), proformaRoutes);

app.use("/api/v1/delivery-person", ...requireSessionAndCompany(), deliveryPersonRoutes);
app.use("/api/v1/site", ...requireSessionAndCompany(), siteRoutes);

app.use("/api/users", ...requireSessionAndCompany(), userRoutes);

app.use("/api/gst/auth", ...requireSessionAndCompany(), gstAuthRoutes);

app.use(
  "/api/v1/ledger-pdf",
  ...requireSessionAndCompany(),
  ledgerPdfRoutes
);
/* =================================
   INVITE APIs
================================= */

app.use(
  "/api/invites",
  ...requireSessionAndCompany(),
  invitesRoutes
);

/* =================================
   EMAIL VERIFICATION (signup OTP)
   Each route uses verifySession() itself (see invites.routes.js for the
   same pattern), so no requireSessionOrApiKey wrapper here.
================================= */

app.use(
  "/api/email-verification",
  emailVerificationRoutes
);

/* =================================
   ACCOUNT APIs
================================= */

app.use(
  "/api/account",
  ...requireSessionAndCompany(),
  accountRoutes
);

app.use("/api/v1/challan", ...requireSessionAndCompany(), challanPdfRoutes); 

app.use("/api/v1/quotation", ...requireSessionAndCompany(), quotationRoutes);

app.use("/api/v1/quotation", ...requireSessionAndCompany(), quotationPdfRoutes);

// Was implemented (src/api/ledgerpdf.routes.js) but never mounted, so
// every ledger "Print" click on the ledger detail page 404'd.
app.use("/api/v1/ledger-pdf", ...requireSessionAndCompany(), ledgerPdfRoutes);

app.use("/api/gst/return-status", ...requireSessionAndCompany(), gstReturnStatusRoutes);
app.use(
  "/api/companies",
  ...requireSessionAndCompany(),
  companyLogoRoutes
);

app.use("/api", bulkSalesV2Routes);
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
