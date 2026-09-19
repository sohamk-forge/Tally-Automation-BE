from pathlib import Path
BASE_DIR = Path(__file__).resolve().parent.parent
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

DEFAULT_EXCEL_SHEET_NAME = "GSTR2B_B2B"
DEFAULT_HEADER_ROW = 6

DEFAULT_CDN_SHEET_NAME = "GSTR2B_CDNR"
DEFAULT_CDN_NOTE_TYPE = "Credit Note"
DEFAULT_DEBIT_NOTE_VOUCHER_TYPE = "Debit Note"

MATCH_FIELDS = ("gstin", "invoice_no", "invoice_date")
STATUS_MATCHED = "Matched"
STATUS_PARTIALLY_MATCHED = "Partially Matched"
STATUS_NOT_IN_TALLY = "Not Present in Tally"
STATUS_NOT_IN_EXCEL = "Not Present in Excel"
STATUS_VARIANCE = "Variance"  # kept for backward compatibility