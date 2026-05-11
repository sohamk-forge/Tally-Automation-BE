import express from "express";
import cors from "cors";

import db from "./api/db.routes.js";
import companies from "./api/companies.routes.js";
import ledgers from "./api/ledgers.routes.js";
import syncRoutes from "./api/sync.routes.js";

/* =================================
   GROUP SUMMARY APIs
================================= */

import groupSummarySC
from "./api/groupSummarySC.routes.js";

import groupSummarySD
from "./api/groupSummarySD.routes.js";

const app = express();

/* =================================
   MIDDLEWARE
================================= */

app.use(cors());

app.use(express.json());

/* =================================
   DATABASE TEST API
================================= */

app.use("/api/db", db);

/* =================================
   COMPANY APIs
================================= */

app.use("/api/companies", companies);

/* =================================
   LEDGER APIs
================================= */

app.use("/api/ledgers", ledgers);

/* =================================
   SYNC APIs
================================= */

app.use("/api/sync", syncRoutes);

/* =================================
   GROUP SUMMARY APIs
================================= */

app.use(
  "/api/group-summary/sc",
  groupSummarySC
);

app.use(
  "/api/group-summary/sd",
  groupSummarySD
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