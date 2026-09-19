import re
from calendar import monthrange
from gst_module.db import fetch_vouchers
from gst_module.utils import clean_amount, clean_date, clean_string

_INVOICE_TOKEN_RE = re.compile(r'^[A-Za-z0-9/]{6,}$')
_DATE_TOKEN_RE = re.compile(r'^\d{1,2}-\d{1,2}-\d{2,4}$')
_INVOICE_LABEL_RE = re.compile(r'Invoice\s*No\.?\s*[:\-]?\s*([A-Za-z0-9/\-]+)', re.IGNORECASE)

def _extract_invoice_no(narration, fallback):
    """Best-effort extraction of the supplier's real invoice number from
    narration text. Falls back to `fallback` (voucher_number) when neither
    pattern matches, which reproduces the old behaviour for that voucher
    (it just won't match GSTR-2B on invoice_no, same as before)."""
    narration = (narration or "").strip()
    if not narration:
        return fallback

    first_token = narration.split("\t", 1)[0].strip()
    if _INVOICE_TOKEN_RE.match(first_token) and not _DATE_TOKEN_RE.match(first_token):
        return first_token

    match = _INVOICE_LABEL_RE.search(narration)
    if match:
        return match.group(1)

    return fallback

class TallyClient:
    """
    Vouchers are already synced into Postgres (table: vouchers) by an
    external process, so this reads them straight from the DB instead of
    calling the Tally sync API over HTTP.

    company_name is the only thing that changes per company/tenant — it's
    always a bind parameter in the SQL, never hardcoded, so the same class
    works for any company already present in the vouchers table.
    """
    def __init__(self, company_name: str, voucher_type: str = "Purchase"):
        if not company_name:
            raise ValueError("company_name is required")
        self.company_name = company_name
        self.voucher_type = voucher_type

    def _resolve_date_range(self, month=None, year=None, from_date=None, to_date=None):
        if from_date and to_date:
            return from_date, to_date
        if month is not None and year is not None:
            last_day = monthrange(year, month)[1]
            start = f"{year}-{month:02d}-01"
            end = f"{year}-{month:02d}-{last_day}"
            return start, end
        return None, None

    def parse(self, month=None, year=None, from_date=None, to_date=None):
        start, end = self._resolve_date_range(month, year, from_date, to_date)
        rows = fetch_vouchers(
            company_name=self.company_name,
            from_date=start,
            to_date=end,
            voucher_type=self.voucher_type,
        )

        return [self._parse_row(row) for row in rows if row.get("ledger_entries")]
    
    def _parse_row(self, row):
        customer_name = clean_string(row.get("party_ledger_name"))
        invoice_no = _extract_invoice_no(
            row.get("narration"), clean_string(row.get("voucher_number"))
        )
        invoice_date = clean_date(row.get("voucher_date"))

        gstin = ""
        taxable_value = 0
        cgst = 0
        sgst = 0
        igst = 0

        ledger_entries = row.get("ledger_entries") or []
        for ledger in ledger_entries:
            ledger_name = clean_string(ledger.get("LEDGERNAME"))
            amount = abs(clean_amount(ledger.get("AMOUNT")))

            if not ledger_name or "Sundry" in ledger_name:
                pass  
            elif "Round Off" in ledger_name:
                pass 
            elif "CGST" in ledger_name:
                cgst += amount
            elif "SGST" in ledger_name:
                sgst += amount
            elif "IGST" in ledger_name:
                igst += amount
            else:
                taxable_value += amount

            if ledger.get("PARTYGSTIN"):
                gstin = clean_string(ledger["PARTYGSTIN"])

        taxable_value = round(taxable_value, 2)
        cgst = round(cgst, 2)
        sgst = round(sgst, 2)
        igst = round(igst, 2)
        total_amount = round(taxable_value + cgst + sgst + igst, 2)
        return {
            "customer_name": customer_name,
            "gstin": gstin,
            "invoice_no": invoice_no,
            "invoice_date": invoice_date,
            "taxable_value": taxable_value,
            "cgst": cgst,
            "sgst": sgst,
            "igst": igst,
            "total_amount": total_amount,
        }