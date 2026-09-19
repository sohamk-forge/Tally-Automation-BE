import os
import shutil
import logging
from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse
from typing import Optional
from gst_module.config import UPLOAD_DIR, DEFAULT_DEBIT_NOTE_VOUCHER_TYPE
from gst_module.excel_reader import ExcelReader, CdnExcelReader
from gst_module.tally_client import TallyClient
from gst_module.reconciliation import ReconciliationEngine
from gst_module.models import ReconciliationActionRequest
from gst_module.db import (
    ensure_reconciliation_table,
    upsert_reconciliation_results,
    get_reconciliation_record,
    update_review_status,
    get_review_status_counts,
    get_reconciled_totals,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# Ensure reconciliation_results table exists on module load
try:
    ensure_reconciliation_table()
    logger.info("reconciliation_results table ready")
except Exception as e:
    logger.warning("Could not ensure reconciliation_results table: %s", e)

@router.get("/gst")
def home():
    return {"message": "GST Reconciliation API is Running"}

@router.post("/reconcile")
async def reconcile(
    file: UploadFile = File(...),
    month: Optional[int] = Form(None),
    year: Optional[int] = Form(None),
    from_date: Optional[str] = Form(None, description="YYYY-MM-DD, use with to_date for a quarter/custom range"),
    to_date: Optional[str] = Form(None, description="YYYY-MM-DD, use with from_date for a quarter/custom range"),
    company_name: Optional[str] = Form(..., description="Exact company_name as stored in the vouchers table"),
    sheet_name: Optional[str] = Form(
        None, description="Override GSTR2B_B2B Excel sheet name if this company's export differs from the standard template"
    ),
    header_row: Optional[int] = Form(
        None, description="Override header row offset if this company's export differs from the standard template"
    ),
    voucher_type: Optional[str] = Form(
        None, description="Tally voucher_type to filter on for purchases (default: Purchase)"
    ),
    cdn_sheet_name: Optional[str] = Form(
        None, description="Override GSTR2B_CDNR Excel sheet name if this company's export differs from the standard template (default: GSTR2B_CDNR)"
    ),
    cdn_header_row: Optional[int] = Form(
        None, description="Override CDN header row offset if this company's export differs from the standard template (default: 5)"
    ),
    debit_note_voucher_type: Optional[str] = Form(
        None, description="Tally voucher_type to filter on for debit notes (default: Debit Note)"
    ),
    note_type: Optional[str] = Form(
        None, description="CDN sheet 'Type of note (Debit/ Credit)' value to reconcile against (default: Credit Note, since a supplier's credit note is booked as a purchase-side debit note in Tally)"
    ),
):
    if not file.filename.endswith((".xlsx", ".xls")):
        raise HTTPException(status_code=400, detail="Only Excel files are allowed.")

    if not ((month and year) or (from_date and to_date)):
        raise HTTPException(
            status_code=400,
            detail="Provide either (month and year) or (from_date and to_date)."
        )

    file_path = os.path.join(UPLOAD_DIR, file.filename)
    try:
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        excel_reader = ExcelReader(file_path, sheet_name=sheet_name, header_row=header_row)
        excel_data = excel_reader.read(month=month, year=year, from_date=from_date, to_date=to_date)

        tally_client = TallyClient(company_name=company_name, voucher_type=voucher_type or "Purchase")
        tally_data = tally_client.parse(month=month, year=year, from_date=from_date, to_date=to_date)

        purchase_result = ReconciliationEngine(excel_data, tally_data).reconcile()
        cdn_excel_reader = CdnExcelReader(
            file_path, sheet_name=cdn_sheet_name, header_row=cdn_header_row, note_type=note_type
        )
        cdn_excel_data = cdn_excel_reader.read(month=month, year=year, from_date=from_date, to_date=to_date)

        cdn_tally_client = TallyClient(
            company_name=company_name, voucher_type=debit_note_voucher_type or DEFAULT_DEBIT_NOTE_VOUCHER_TYPE
        )
        cdn_tally_data = cdn_tally_client.parse(month=month, year=year, from_date=from_date, to_date=to_date)

        debit_note_result = ReconciliationEngine(cdn_excel_data, cdn_tally_data, source_label="cdn").reconcile()

        # ---- Persist results to DB (preserves existing review_status) ----
        try:
            all_purchase_records = (
                purchase_result.get("matched_records", []) +
                purchase_result.get("partially_matched_records", []) +
                purchase_result.get("only_in_tally", []) +
                purchase_result.get("only_in_gstr2b", [])
            )
            upsert_reconciliation_results(company_name, "purchase", all_purchase_records)

            all_cdn_records = (
                debit_note_result.get("matched_records", []) +
                debit_note_result.get("partially_matched_records", []) +
                debit_note_result.get("only_in_tally", []) +
                debit_note_result.get("only_in_cdn", [])
            )
            upsert_reconciliation_results(company_name, "debit_note", all_cdn_records)

            # Fetch review_status counts and reconciled_totals from DB
            purchase_counts = get_review_status_counts(company_name, "purchase") or {}
            purchase_recon_totals = get_reconciled_totals(company_name, "purchase") or {}
            cdn_counts = get_review_status_counts(company_name, "debit_note") or {}
            cdn_recon_totals = get_reconciled_totals(company_name, "debit_note") or {}

            # Update purchase summary with DB-driven counts
            purchase_result["reconciliation_summary"]["reconciled_invoices"] = int(purchase_counts.get("reconciled_invoices", 0))
            purchase_result["reconciliation_summary"]["pending_invoices"] = int(purchase_counts.get("pending_invoices", 0))
            purchase_result["reconciliation_summary"]["unreviewed_invoices"] = int(purchase_counts.get("unreviewed_invoices", 0))
            purchase_result["reconciliation_summary"]["reconciled_totals"] = {
                "taxable_value": float(purchase_recon_totals.get("taxable_value", 0)),
                "cgst": float(purchase_recon_totals.get("cgst", 0)),
                "sgst": float(purchase_recon_totals.get("sgst", 0)),
                "igst": float(purchase_recon_totals.get("igst", 0)),
                "total_amount": float(purchase_recon_totals.get("total_amount", 0)),
            }

            # Update CDN summary with DB-driven counts
            debit_note_result["reconciliation_summary"]["reconciled_invoices"] = int(cdn_counts.get("reconciled_invoices", 0))
            debit_note_result["reconciliation_summary"]["pending_invoices"] = int(cdn_counts.get("pending_invoices", 0))
            debit_note_result["reconciliation_summary"]["unreviewed_invoices"] = int(cdn_counts.get("unreviewed_invoices", 0))
            debit_note_result["reconciliation_summary"]["reconciled_totals"] = {
                "taxable_value": float(cdn_recon_totals.get("taxable_value", 0)),
                "cgst": float(cdn_recon_totals.get("cgst", 0)),
                "sgst": float(cdn_recon_totals.get("sgst", 0)),
                "igst": float(cdn_recon_totals.get("igst", 0)),
                "total_amount": float(cdn_recon_totals.get("total_amount", 0)),
            }
        except Exception as db_err:
            logger.warning("DB persistence failed (results still returned): %s", db_err)

        return JSONResponse(content={
            "purchase_reconciliation": purchase_result,
            "debit_note_reconciliation": debit_note_result,
        })

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    finally:
        if os.path.exists(file_path):
            os.remove(file_path)


@router.post("/reconcile/action")
async def reconcile_action(request: ReconciliationActionRequest):
    """
    Accept or mark-pending a matched reconciliation record.
    Only works for records with match_status = 'matched'.
    """
    if request.action not in ("accept", "pending"):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid action '{request.action}'. Must be 'accept' or 'pending'."
        )

    # Fetch the record
    record = get_reconciliation_record(request.invoice_id)
    if not record:
        raise HTTPException(
            status_code=404,
            detail=f"Reconciliation record with id {request.invoice_id} not found."
        )

    # Only matched records can be accepted/pending
    if record["match_status"] != "matched":
        raise HTTPException(
            status_code=400,
            detail=f"Actions are allowed only for matched invoices. This record is '{record['match_status']}'."
        )

    # Map action to review_status value
    review_status = "accepted" if request.action == "accept" else "pending"

    updated = update_review_status(request.invoice_id, review_status)
    if not updated:
        raise HTTPException(
            status_code=500,
            detail="Failed to update review status."
        )

    return JSONResponse(content={
        "success": True,
        "invoice_id": request.invoice_id,
        "match_status": updated["match_status"],
        "review_status": updated["review_status"],
        "reviewed_at": str(updated["reviewed_at"]) if updated.get("reviewed_at") else None,
    })