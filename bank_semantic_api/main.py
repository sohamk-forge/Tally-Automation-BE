from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd
import io

from .semantic import process_transactions

app = FastAPI(
    title="Bank Statement Semantic API",
    description="Upload bank Excel statements → get merchant names + semantic clusters",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def find_header_row(file_bytes: bytes, filename: str) -> int:
    """Scan first 30 rows to find where actual headers are (Date, Narration etc.)"""
    header_keywords = {"date", "narration", "txn date", "transaction date", "particulars", "description"}
    try:
        engine = "xlrd" if filename.lower().endswith(".xls") else "openpyxl"
        df_raw = pd.read_excel(io.BytesIO(file_bytes), header=None, nrows=30, engine=engine, dtype=str)
        for i, row in df_raw.iterrows():
            for cell in row:
                if str(cell).strip().lower() in header_keywords:
                    return i
    except Exception:
        pass
    return 0


def is_separator_row(row) -> bool:
    """Skip rows full of asterisks or dashes (bank separator lines like ******)"""
    values = [str(v).strip().replace("*", "").replace("-", "").replace(" ", "") for v in row]
    return all(v == "" for v in values)


COLUMN_MAPPING = {
    # Date
    "Date":                "transaction_date",
    "Txn Date":            "transaction_date",
    "Transaction Date":    "transaction_date",
    "Value Dt":            "value_date",
    "Value Date":          "value_date",
    "VALUE DATE":          "value_date",
    # Narration
    "Narration":           "narration",
    "Description":         "narration",
    "Particulars":         "narration",
    "Transaction Remarks": "narration",
    "Remarks":             "narration",
    # Cheque/Ref
    "Chq./Ref.No.":        "cheque_ref",
    "Chq/Ref No.":         "cheque_ref",
    "Chq No":              "cheque_ref",
    "Ref No":              "cheque_ref",
    # Withdrawal
    "Withdrawal Amt.":     "withdrawal",
    "Withdrawal Amt":      "withdrawal",
    "Debit":               "withdrawal",
    "DR":                  "withdrawal",
    # Deposit
    "Deposit Amt.":        "deposit",
    "Deposit Amt":         "deposit",
    "Credit":              "deposit",
    "CR":                  "deposit",
    # Balance
    "Closing Balance":     "balance",
    "Balance":             "balance",
}


def normalize_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    df.columns = [str(c).strip() for c in df.columns]
    df.rename(columns=COLUMN_MAPPING, inplace=True)

    for col in ["transaction_date", "narration", "withdrawal", "deposit", "balance"]:
        if col not in df.columns:
            df[col] = ""

    if "value_date" not in df.columns:
        df["value_date"] = df.get("transaction_date", "")

    if "cheque_ref" not in df.columns:
        df["cheque_ref"] = ""

    df = df.fillna("")
    for col in df.columns:
        df[col] = df[col].astype(str).replace("nan", "").replace("None", "")

    return df


def has_amount(row) -> bool:
    """Keep only rows that have a withdrawal or deposit value."""
    w = str(row.get("withdrawal", "")).strip().replace(",", "")
    d = str(row.get("deposit", "")).strip().replace(",", "")
    try:
        return float(w) > 0 or float(d) > 0
    except ValueError:
        return False


@app.get("/")
def home():
    return {"message": "Semantic Bank API Running ✅"}


@app.post("/api/upload-excel")
async def upload_excel(file: UploadFile = File(...)):
    filename = file.filename or ""

    if not (filename.lower().endswith(".xls") or filename.lower().endswith(".xlsx")):
        raise HTTPException(
            status_code=415,
            detail="Only .xls or .xlsx files are supported."
        )

    try:
        file_bytes = await file.read()
        engine     = "xlrd" if filename.lower().endswith(".xls") else "openpyxl"
        header_row = find_header_row(file_bytes, filename)

        # Read Excel with correct header row
        df = pd.read_excel(
            io.BytesIO(file_bytes),
            header=header_row,
            engine=engine,
            dtype=str
        )

        if df.empty:
            raise HTTPException(status_code=400, detail="No data found in the Excel file.")

        # Remove HDFC-style separator rows (rows full of ***)
        df = df[~df.apply(is_separator_row, axis=1)].reset_index(drop=True)

        # Normalize column names to standard names
        df = normalize_dataframe(df)

        # Keep only rows with actual transaction amounts
        df = df[df.apply(has_amount, axis=1)].reset_index(drop=True)

        if df.empty:
            raise HTTPException(status_code=400, detail="No valid transaction rows found.")

        # ── Build narrations list exactly like your manual code ──
        narrations = [str(row.get("narration", "")).strip() for _, row in df.iterrows()]

        # ── Build full transaction list ──
        transactions = []
        for _, row in df.iterrows():
            transactions.append({
                "transaction_date": str(row.get("transaction_date", "")).strip(),
                "value_date":       str(row.get("value_date", "")).strip(),
                "narration":        str(row.get("narration", "")).strip(),
                "cheque_ref":       str(row.get("cheque_ref", "")).strip(),
                "withdrawal":       str(row.get("withdrawal", "")).strip(),
                "deposit":          str(row.get("deposit", "")).strip(),
                "balance":          str(row.get("balance", "")).strip(),
                "merchant_name":    "",
                "group_key":        "",
            })

        # ── Run your exact semantic logic from semantic.py ──
        processed = process_transactions(transactions)

        return {
            "success":      True,
            "file_name":    filename,
            "total":        len(processed),
            "transactions": processed
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))