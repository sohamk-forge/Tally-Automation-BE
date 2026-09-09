/**
 * src/api/site.routes.js
 *
 * Register in app.js:
 *   import siteRoutes from "./api/site.routes.js";
 *   app.use("/api/v1/site", siteRoutes);
 *
 * ─────────────────────────────────────────────
 * ENDPOINTS
 * ─────────────────────────────────────────────
 *
 *   GET  /api/v1/site?company_id=1&customer_name=ABC%20Traders
 *        → Returns saved sites for the given customer, for the
 *          "Select Site" dropdown.
 *
 *   POST /api/v1/site   { company_id, customer_name, site_name }
 *        → Creates a site. Call this from the "+ Create new site" inline
 *          form, then refresh/prepend the dropdown with the returned
 *          record instead of only holding it in local state.
 *
 *   GET  /api/v1/site/:id?company_id=1
 *        → Returns a single site by id.
 */

import express from "express";
import {
  listSitesForCustomer,
  createSite,
  getSiteById,
} from "../services/site.service.js";

const router = express.Router();

function ok(res, status, payload) {
  return res.status(status).json({ success: true, ...payload });
}

function errRes(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/site?company_id=1&customer_name=ABC
// ─────────────────────────────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  try {
    const { company_id, customer_name } = req.query;
    if (!company_id) return errRes(res, 400, "company_id is required");

    const sites = await listSitesForCustomer(Number(company_id), customer_name);
    return ok(res, 200, { count: sites.length, data: sites });
  } catch (err) {
    console.error("[Site] list:", err.message);
    return errRes(res, 500, err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/site
// ─────────────────────────────────────────────────────────────────────────────

router.post("/", async (req, res) => {
  try {
    const { company_id, customer_name, site_name } = req.body;
    if (!company_id) return errRes(res, 400, "company_id is required");
    if (!customer_name) return errRes(res, 400, "customer_name is required");
    if (!site_name) return errRes(res, 400, "site_name is required");

    const site = await createSite(Number(company_id), {
      customer_name,
      site_name,
    });

    return ok(res, 201, {
      message: `Site "${site.site_name}" created`,
      data: site,
    });
  } catch (err) {
    console.error("[Site] create:", err.message);
    return errRes(res, 500, err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/site/:id?company_id=1
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id", async (req, res) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return errRes(res, 400, "company_id is required");

    const site = await getSiteById(Number(company_id), Number(req.params.id));
    if (!site) return errRes(res, 404, "Site not found");

    return ok(res, 200, { data: site });
  } catch (err) {
    console.error("[Site] get:", err.message);
    return errRes(res, 500, err.message);
  }
});

export default router;
