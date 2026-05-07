import express from "express";
import cors from "cors";

import db from "./api/db.routes.js";
import sync from "./api/sync.routes.js";
import companies from "./api/companies.routes.js";
import ledgers from "./api/ledgers.routes.js";
import products from "./api/products.routes.js";
import vouchers from "./api/vouchers.routes.js";  // ✅ ADD THIS

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/sync", sync);           // Sync APIs (Tally → DB)
app.use("/api/companies", companies); // Read companies from DB
app.use("/api/ledgers", ledgers);     // Read ledgers from DB
app.use("/api/products", products);   // Read products from DB
app.use("/api/vouchers", vouchers);   // ✅ ADD THIS - Read vouchers from DB
app.use("/api/db", db);               // DB test endpoint

export default app;