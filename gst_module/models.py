from pydantic import BaseModel
from typing import Optional

class Invoice(BaseModel):
    customer_name: str
    gstin: str
    invoice_no: str
    invoice_date: str
    taxable_value: float
    cgst: float
    sgst: float
    igst: float
    total_amount: float

class FinancialTotals(BaseModel):
    taxable_value: float = 0
    cgst: float = 0
    sgst: float = 0
    igst: float = 0
    total_amount: float = 0

class Summary(BaseModel):
    total_invoices: int
    matched_invoices: int
    partially_matched_invoices: int = 0
    not_present_in_tally: int
    not_present_in_excel: int
    total_taxable_value: float
    total_cgst: float
    total_sgst: float
    total_igst: float
    total_amount: float
    total_variance: float
    reconciled_invoices: int = 0
    pending_invoices: int = 0
    unreviewed_invoices: int = 0
    matched_totals: Optional[FinancialTotals] = None
    reconciled_totals: Optional[FinancialTotals] = None

class APIResponse(BaseModel):
    summary: Summary
    records: list

class ReconciliationActionRequest(BaseModel):
    invoice_id: int
    action: str  # "accept" or "pending"