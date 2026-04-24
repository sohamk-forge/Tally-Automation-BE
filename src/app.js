import express from "express";
import cors from "cors";

import sync from "./api/sync.routes.js";
import companies from "./api/companies.routes.js";
import ledgers from "./api/ledgers.routes.js";
import products from "./api/products.routes.js";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/sync", sync);
app.use("/api/companies", companies);
app.use("/api/ledgers", ledgers);
app.use("/api/products", products);

export default app;