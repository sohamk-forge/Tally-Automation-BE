import express from "express";
import authMiddleware from "../middleware/auth.middleware.js";
import { checkCompanyAccess, validateCompanyId } from "../utils/companyAccess.js";
import {
  createChallan,
  getAllChallans,
  getChallanById,
  updateChallanStatus,
  peekNextChallanNumber,
} from "../services/challan.service.js";

const router = express.Router();

function ok(res, status, payload) {
  return res.status(status).json({ success: true, ...payload });
}

function errRes(res, status, message, details) {
  return res.status(status).json({
    success: false,
    error: message,
    ...(details ? { details } : {}),
  });
}

router.get("/next-number", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const companyId = validateCompanyId(req.query.company_id);
    
    if (!companyId) return errRes(res, 400, "company_id is required");

    const hasAccess = await checkCompanyAccess(userId, companyId);
    if (!hasAccess) return errRes(res, 403, "You don't have access to this company");

    const preview = await peekNextChallanNumber(companyId);
    return ok(res, 200, { data: preview });
  } catch (err) {
    console.error("[Challan] next-number:", err.message);
    return errRes(res, 500, err.message);
  }
});

async function handleCreate(userId, req, res) {
  const {
    company_id, company_name,
    challan_date, customer_name, customer_gstin, customer_address,
    narration, supply_type, items,
  } = req.body;

  if (!company_id) return errRes(res, 400, "company_id is required");
  if (!challan_date) return errRes(res, 400, "challan_date is required");
  if (!Array.isArray(items) || items.length === 0) {
    return errRes(res, 400, "items[] array with at least one item is required");
  }

  const companyId = validateCompanyId(company_id);
  if (!companyId) return errRes(res, 400, "Valid company_id required");

  const hasAccess = await checkCompanyAccess(userId, companyId);
  if (!hasAccess) return errRes(res, 403, "You don't have access to this company");

  try {
    const challan = await createChallan({
      company_id: companyId,
      company_name,
      challan_date,
      customer_name,
      customer_gstin,
      customer_address,
      narration,
      supply_type,
      items,
    });

    return ok(res, 201, {
      message: `Challan ${challan.challan_number} created successfully`,
      data: challan,
    });
  } catch (err) {
    console.error("[Challan] create:", err.message);
    return errRes(res, 500, err.message);
  }
}

async function handleList(userId, req, res) {
  const { company_id, status, from_date, to_date, customer_name } = req.body;

  if (!company_id) return errRes(res, 400, "company_id is required");

  const companyId = validateCompanyId(company_id);
  if (!companyId) return errRes(res, 400, "Valid company_id required");

  const hasAccess = await checkCompanyAccess(userId, companyId);
  if (!hasAccess) return errRes(res, 403, "You don't have access to this company");

  try {
    const challans = await getAllChallans(companyId, {
      status,
      from_date,
      to_date,
      customer_name,
    });

    return ok(res, 200, { count: challans.length, data: challans });
  } catch (err) {
    console.error("[Challan] list:", err.message);
    return errRes(res, 500, err.message);
  }
}

async function handleGet(userId, req, res) {
  const { company_id, challan_id } = req.body;

  if (!company_id) return errRes(res, 400, "company_id is required");
  if (!challan_id) return errRes(res, 400, "challan_id is required");

  const companyId = validateCompanyId(company_id);
  if (!companyId) return errRes(res, 400, "Valid company_id required");

  const hasAccess = await checkCompanyAccess(userId, companyId);
  if (!hasAccess) return errRes(res, 403, "You don't have access to this company");

  try {
    const challan = await getChallanById(Number(challan_id), companyId);
    if (!challan) return errRes(res, 404, "Challan not found");

    return ok(res, 200, { data: challan });
  } catch (err) {
    console.error("[Challan] get:", err.message);
    return errRes(res, 500, err.message);
  }
}

async function handleUpdateStatus(userId, req, res) {
  const { company_id, challan_id, status } = req.body;

  if (!company_id) return errRes(res, 400, "company_id is required");
  if (!challan_id) return errRes(res, 400, "challan_id is required");
  if (!status) return errRes(res, 400, "status is required");

  const companyId = validateCompanyId(company_id);
  if (!companyId) return errRes(res, 400, "Valid company_id required");

  const hasAccess = await checkCompanyAccess(userId, companyId);
  if (!hasAccess) return errRes(res, 403, "You don't have access to this company");

  try {
    const updated = await updateChallanStatus(
      Number(challan_id),
      companyId,
      String(status).toUpperCase()
    );

    if (!updated) return errRes(res, 404, "Challan not found");

    return ok(res, 200, {
      message: `Challan status updated to ${updated.status}`,
      data: updated,
    });
  } catch (err) {
    console.error("[Challan] update_status:", err.message);
    return errRes(res, 500, err.message);
  }
}

router.post("/", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { action } = req.body;

  switch (action) {
    case "create":
      return handleCreate(userId, req, res);
    case "list":
      return handleList(userId, req, res);
    case "get":
      return handleGet(userId, req, res);
    case "update_status":
      return handleUpdateStatus(userId, req, res);
    default:
      return errRes(
        res, 400,
        `Invalid or missing "action". Must be one of: "create", "list", "get", "update_status".`
      );
  }
});

router.get("/all", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const companyId = validateCompanyId(req.query.company_id);
    
    if (!companyId) return errRes(res, 400, "company_id is required");

    const hasAccess = await checkCompanyAccess(userId, companyId);
    if (!hasAccess) return errRes(res, 403, "You don't have access to this company");

    const { status, from_date, to_date, customer_name } = req.query;
    const challans = await getAllChallans(companyId, {
      status,
      from_date,
      to_date,
      customer_name,
    });

    return ok(res, 200, { count: challans.length, data: challans });
  } catch (err) {
    console.error("[Challan] GET all:", err.message);
    return errRes(res, 500, err.message);
  }
});

router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const companyId = validateCompanyId(req.query.company_id);
    
    if (!companyId) return errRes(res, 400, "company_id is required");

    const hasAccess = await checkCompanyAccess(userId, companyId);
    if (!hasAccess) return errRes(res, 403, "You don't have access to this company");

    const challan = await getChallanById(Number(req.params.id), companyId);
    if (!challan) return errRes(res, 404, "Challan not found");

    return ok(res, 200, { data: challan });
  } catch (err) {
    console.error("[Challan] GET by id:", err.message);
    return errRes(res, 500, err.message);
  }
});

export default router;