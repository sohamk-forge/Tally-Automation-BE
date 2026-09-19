import pandas as pd
from gst_module.config import (
    DEFAULT_EXCEL_SHEET_NAME,
    DEFAULT_HEADER_ROW,
    DEFAULT_CDN_SHEET_NAME,
    DEFAULT_CDN_NOTE_TYPE,
)
from gst_module.utils import clean_amount, clean_date, clean_string, filter_by_date_range
class ExcelReader:
    def __init__(self, file_path: str, sheet_name: str = None, header_row: int = None):
        self.file_path = file_path
        self.sheet_name = sheet_name or DEFAULT_EXCEL_SHEET_NAME
        self.header_row = header_row if header_row is not None else DEFAULT_HEADER_ROW

    def read(self, month=None, year=None, from_date=None, to_date=None):
        try:
            df = pd.read_excel(
                self.file_path,
                sheet_name=self.sheet_name,
                header=self.header_row,
            )
        except Exception as e:
            raise Exception(
                f"Unable to read Excel file (sheet='{self.sheet_name}', "
                f"header_row={self.header_row}): {e}"
            )

        df = df.fillna("")
        invoices = []
        for _, row in df.iterrows():
            invoice_no = clean_string(row.get("Invoice number"))

            if invoice_no == "":
                continue
            invoice = {
                "customer_name": clean_string(row.get("Trade/Legal name")),
                "gstin": clean_string(row.get("GSTIN of supplier")),
                "invoice_no": invoice_no,
                "invoice_date": clean_date(row.get("Invoice Date")),
                "taxable_value": clean_amount(row.get("Taxable Value")),
                "cgst": clean_amount(row.get("Central Tax")),
                "sgst": clean_amount(row.get("State/UT Tax")),
                "igst": clean_amount(row.get("Integrated Tax")),
                "total_amount": clean_amount(row.get("Invoice Value")),
            }
            invoices.append(invoice)

        if from_date and to_date:
            range_start = pd.to_datetime(from_date)
            range_end = pd.to_datetime(to_date)
        elif month is not None and year is not None:
            range_start = pd.Timestamp(year=year, month=month, day=1)
            range_end = range_start + pd.offsets.MonthEnd(0)
        else:
            return invoices

        filtered_invoices = []
        for invoice in invoices:
          
            invoice_date = pd.to_datetime(invoice["invoice_date"], errors="coerce")
            if pd.isna(invoice_date):
                continue
            if range_start <= invoice_date <= range_end:
                filtered_invoices.append(invoice)
        return filtered_invoices


class CdnExcelReader:
    """
    Reads the GSTR2B_CDNR sheet (credit/debit notes issued by suppliers) and
    maps it into the same generic dict shape ExcelReader produces
    (customer_name, gstin, invoice_no, invoice_date, taxable_value, cgst,
    sgst, igst, total_amount), so ReconciliationEngine can be reused as-is.

    A supplier's "Credit Note" is what Tally records as a "Debit Note" on
    the recipient's purchase side, so note_type defaults to "Credit Note"
    to select the rows that should be reconciled against Tally debit notes.

    Different GSTR2B_CDNR exports (GST portal vs Tally-generated vs others)
    use different column headers and header-row offsets for the same data,
    so both are resolved dynamically from the sheet itself rather than
    assumed fixed, e.g. "Note number"/"Debit Note/ credit note/ Refund
    voucher No." for the same field.
    """

    COLUMN_ALIASES = {
        "note_no": ["Debit Note/ credit note/ Refund voucher No.", "Note number"],
        "note_type": ["Type of note (Debit/ Credit)", "Note type"],
        "note_date": ["Debit Note/ credit note/ Refund voucher Date", "Note date"],
        "party_name": ["Party Name", "Trade/Legal name"],
        "gstin": ["GSTIN/UIN of Recipient", "GSTIN of supplier"],
        "taxable_value": ["Taxable Value"],
        "cgst": ["CGST Amount", "Central Tax"],
        "sgst": ["SGST Amount", "State/UT Tax"],
        "igst": ["IGST Amount", "Integrated Tax"],
        "total_amount": ["Note/Refund Voucher Value", "Note Value"],
        "original_invoice_no": ["Original Invoice No"],
    }

    def __init__(self, file_path: str, sheet_name: str = None, header_row: int = None, note_type: str = None):
        self.file_path = file_path
        self.sheet_name = sheet_name or DEFAULT_CDN_SHEET_NAME
        self.header_row = header_row
        self.note_type = note_type or DEFAULT_CDN_NOTE_TYPE

    def _known_header_labels(self):
        return {
            alias.strip().lower()
            for aliases in self.COLUMN_ALIASES.values()
            for alias in aliases
        }

    def _detect_header_row(self, max_scan_rows: int = 15) -> int:
        """Scans the first few rows for whichever one contains the most
        recognizable column labels, since report title/company-name rows
        above the real header vary in count between exports."""
        preview = pd.read_excel(
            self.file_path, sheet_name=self.sheet_name, header=None, nrows=max_scan_rows
        )
        known_labels = self._known_header_labels()
        best_row, best_score = 0, -1
        for i in range(len(preview)):
            row_labels = {
                str(v).strip().lower() for v in preview.iloc[i].tolist() if str(v).strip()
            }
            score = len(row_labels & known_labels)
            if score > best_score:
                best_score = score
                best_row = i
        return best_row

    def _resolve_columns(self, columns):
        normalized = {str(c).strip().lower(): c for c in columns}
        resolved = {}
        for field, aliases in self.COLUMN_ALIASES.items():
            resolved[field] = next(
                (normalized[a.strip().lower()] for a in aliases if a.strip().lower() in normalized),
                None,
            )
        return resolved

    def read(self, month=None, year=None, from_date=None, to_date=None):
        header_row = self.header_row if self.header_row is not None else self._detect_header_row()
        try:
            df = pd.read_excel(
                self.file_path,
                sheet_name=self.sheet_name,
                header=header_row,
            )
        except Exception as e:
            raise Exception(
                f"Unable to read Excel file (sheet='{self.sheet_name}', "
                f"header_row={header_row}): {e}"
            )

        df = df.fillna("")
        cols = self._resolve_columns(df.columns)

        def get(row, field):
            col = cols.get(field)
            return row.get(col) if col else ""

        notes = []
        for _, row in df.iterrows():
            note_no = clean_string(get(row, "note_no"))
            if note_no == "":
                continue

            note_type = clean_string(get(row, "note_type"))
            if self.note_type and note_type.lower() != self.note_type.lower():
                continue

            note = {
                "customer_name": clean_string(get(row, "party_name")),
                "gstin": clean_string(get(row, "gstin")),
                "invoice_no": note_no,
                "invoice_date": clean_date(get(row, "note_date")),
                "taxable_value": clean_amount(get(row, "taxable_value")),
                "cgst": clean_amount(get(row, "cgst")),
                "sgst": clean_amount(get(row, "sgst")),
                "igst": clean_amount(get(row, "igst")),
                "total_amount": clean_amount(get(row, "total_amount")),
                "note_type": note_type,
                "original_invoice_no": clean_string(get(row, "original_invoice_no")),
            }
            notes.append(note)

        return filter_by_date_range(notes, "invoice_date", month, year, from_date, to_date)