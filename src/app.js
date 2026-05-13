import express from "express";
import cors from "cors";

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

/* =================================
   GROUP SUMMARY APIs
================================= */

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

const app = express();

/* =================================
   MIDDLEWARE
================================= */

app.use(cors());

app.use(express.json());

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
   OLD SYNC APIs
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
app.use(
  "/api",
  ledgerVouchersRoutes
);
app.use(
  "/api",
  parentGroupsRoutes
);
app.use(
  "/api",
  payableDebtorsRoutes
);

/* =================================
   DEFAULT API
================================= */

app.get("/", (req, res) => {

  return res.json({

    status: "success",

    message:
      "Tally Integration API Running"

  });

});

export default app;