import os
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv
load_dotenv()

DB_HOST = os.getenv("DB_HOST")
DB_PORT = os.getenv("DB_PORT")
DB_NAME = os.getenv("DB_NAME")
DB_USER = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")
DB_SCHEMA = os.getenv("DB_SCHEMA", "app_test")

def get_connection():
    return psycopg2.connect(
        host=DB_HOST,
        port=DB_PORT,
        dbname=DB_NAME,
        user=DB_USER,
        password=DB_PASSWORD,
    )

def fetch_vouchers(company_name: str, from_date=None, to_date=None, voucher_type=None):
    """
    Reads already-synced vouchers straight from Postgres (table: vouchers),
    filtered by company_name and optionally a date range and voucher_type.
    No two companies share a query — company_name is always a bind parameter,
    never hardcoded, so this works for any company already synced into the table.
    voucher_type: pass "Purchase", "Debit Note", etc. to restrict results to
    that voucher type. Matched case/space-insensitively since different Tally
    syncs have stored the same type as "Debit Note" or "DebitNote". Leave as
    None to fetch all voucher types (old behaviour).
    ledger_entries is jsonb — psycopg2 hands it back as a native Python
    list of dicts automatically, no manual json.loads needed.
    """
    conn = get_connection()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            query = f"""
                SELECT
                    company_name,
                    voucher_date,
                    voucher_type,
                    voucher_number,
                    party_ledger_name,
                    narration,
                    ledger_entries
                FROM {DB_SCHEMA}.vouchers
                WHERE company_name = %s
            """
            params = [company_name]

            if from_date and to_date:
                query += " AND voucher_date BETWEEN %s AND %s"
                params.extend([from_date, to_date])

            if voucher_type:
                query += " AND REPLACE(LOWER(voucher_type), ' ', '') = REPLACE(LOWER(%s), ' ', '')"
                params.append(voucher_type)

            cur.execute(query, params)
            rows = cur.fetchall()
            return rows
    except Exception as e:
        raise Exception(f"Database error fetching vouchers for '{company_name}': {e}")
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Reconciliation results persistence
# ---------------------------------------------------------------------------

def ensure_reconciliation_table():
    """Create the reconciliation_results table if it doesn't exist."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(f"""
                CREATE TABLE IF NOT EXISTS {DB_SCHEMA}.reconciliation_results (
                    id                    SERIAL PRIMARY KEY,
                    company_name          VARCHAR(255) NOT NULL,
                    source_type           VARCHAR(20)  NOT NULL DEFAULT 'purchase',
                    gstin                 VARCHAR(20),
                    party_name            VARCHAR(255),
                    invoice_no            VARCHAR(100),
                    invoice_date          VARCHAR(20),
                    match_status          VARCHAR(30)  NOT NULL,
                    review_status         VARCHAR(20)  NOT NULL DEFAULT 'unreviewed',

                    source_taxable_value  NUMERIC(15,2) DEFAULT 0,
                    source_cgst           NUMERIC(15,2) DEFAULT 0,
                    source_sgst           NUMERIC(15,2) DEFAULT 0,
                    source_igst           NUMERIC(15,2) DEFAULT 0,
                    source_total_amount   NUMERIC(15,2) DEFAULT 0,

                    tally_taxable_value   NUMERIC(15,2) DEFAULT 0,
                    tally_cgst            NUMERIC(15,2) DEFAULT 0,
                    tally_sgst            NUMERIC(15,2) DEFAULT 0,
                    tally_igst            NUMERIC(15,2) DEFAULT 0,
                    tally_total_amount    NUMERIC(15,2) DEFAULT 0,

                    taxable_difference    NUMERIC(15,2) DEFAULT 0,
                    cgst_difference       NUMERIC(15,2) DEFAULT 0,
                    sgst_difference       NUMERIC(15,2) DEFAULT 0,
                    igst_difference       NUMERIC(15,2) DEFAULT 0,
                    total_difference      NUMERIC(15,2) DEFAULT 0,

                    matched_by            VARCHAR(20),
                    reviewed_at           TIMESTAMP,
                    reviewed_by           VARCHAR(100),
                    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                    UNIQUE(company_name, source_type, gstin, invoice_no, invoice_date)
                );
            """)
        conn.commit()
    except Exception as e:
        conn.rollback()
        raise Exception(f"Error creating reconciliation_results table: {e}")
    finally:
        conn.close()


def upsert_reconciliation_results(company_name: str, source_type: str, records: list):
    """
    Bulk upsert reconciliation records.
    On conflict (same company + source_type + gstin + invoice_no + invoice_date):
      - Updates match_status and financial fields
      - PRESERVES existing review_status (so accepted/pending survive re-reconciliation)
    """
    if not records:
        return

    conn = get_connection()
    try:
        with conn.cursor() as cur:
            for rec in records:
                cur.execute(f"""
                    INSERT INTO {DB_SCHEMA}.reconciliation_results (
                        company_name, source_type, gstin, party_name,
                        invoice_no, invoice_date, match_status, review_status,
                        source_taxable_value, source_cgst, source_sgst, source_igst, source_total_amount,
                        tally_taxable_value, tally_cgst, tally_sgst, tally_igst, tally_total_amount,
                        taxable_difference, cgst_difference, sgst_difference, igst_difference, total_difference,
                        matched_by
                    ) VALUES (
                        %s, %s, %s, %s,
                        %s, %s, %s, 'unreviewed',
                        %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s,
                        %s
                    )
                    ON CONFLICT (company_name, source_type, gstin, invoice_no, invoice_date)
                    DO UPDATE SET
                        match_status          = EXCLUDED.match_status,
                        party_name            = EXCLUDED.party_name,
                        source_taxable_value  = EXCLUDED.source_taxable_value,
                        source_cgst           = EXCLUDED.source_cgst,
                        source_sgst           = EXCLUDED.source_sgst,
                        source_igst           = EXCLUDED.source_igst,
                        source_total_amount   = EXCLUDED.source_total_amount,
                        tally_taxable_value   = EXCLUDED.tally_taxable_value,
                        tally_cgst            = EXCLUDED.tally_cgst,
                        tally_sgst            = EXCLUDED.tally_sgst,
                        tally_igst            = EXCLUDED.tally_igst,
                        tally_total_amount    = EXCLUDED.tally_total_amount,
                        taxable_difference    = EXCLUDED.taxable_difference,
                        cgst_difference       = EXCLUDED.cgst_difference,
                        sgst_difference       = EXCLUDED.sgst_difference,
                        igst_difference       = EXCLUDED.igst_difference,
                        total_difference      = EXCLUDED.total_difference,
                        matched_by            = EXCLUDED.matched_by,
                        updated_at            = CURRENT_TIMESTAMP
                """, (
                    company_name, source_type,
                    rec.get("gstin"), rec.get("party_name"),
                    rec.get("invoice_no"), rec.get("invoice_date"),
                    rec.get("match_status"),
                    rec.get("source_taxable_value", 0),
                    rec.get("source_cgst", 0),
                    rec.get("source_sgst", 0),
                    rec.get("source_igst", 0),
                    rec.get("source_total_amount", 0),
                    rec.get("tally_taxable_value", 0),
                    rec.get("tally_cgst", 0),
                    rec.get("tally_sgst", 0),
                    rec.get("tally_igst", 0),
                    rec.get("tally_total_amount", 0),
                    rec.get("taxable_difference", 0),
                    rec.get("cgst_difference", 0),
                    rec.get("sgst_difference", 0),
                    rec.get("igst_difference", 0),
                    rec.get("total_difference", 0),
                    rec.get("matched_by"),
                ))
        conn.commit()
    except Exception as e:
        conn.rollback()
        raise Exception(f"Error upserting reconciliation results: {e}")
    finally:
        conn.close()
        
def get_reconciliation_record(record_id: int):
    """Fetch a single reconciliation record by its primary key."""
    conn = get_connection()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                f"SELECT * FROM {DB_SCHEMA}.reconciliation_results WHERE id = %s",
                (record_id,)
            )
            return cur.fetchone()
    except Exception as e:
        raise Exception(f"Error fetching reconciliation record {record_id}: {e}")
    finally:
        conn.close()
        
def update_review_status(record_id: int, action: str):
    """
    Set review_status to 'accepted' or 'pending' for the given record.
    Also stamps reviewed_at.
    """
    conn = get_connection()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(f"""
                UPDATE {DB_SCHEMA}.reconciliation_results
                SET review_status = %s,
                    reviewed_at   = CURRENT_TIMESTAMP,
                    updated_at    = CURRENT_TIMESTAMP
                WHERE id = %s
                RETURNING *
            """, (action, record_id))
            row = cur.fetchone()
        conn.commit()
        return row
    except Exception as e:
        conn.rollback()
        raise Exception(f"Error updating review status for record {record_id}: {e}")
    finally:
        conn.close()

def get_review_status_counts(company_name: str, source_type: str):
    """
    Return counts of accepted / pending / unreviewed for matched records
    belonging to a given company + source_type.
    """
    conn = get_connection()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(f"""
                SELECT
                    COALESCE(SUM(CASE WHEN review_status = 'accepted'   THEN 1 ELSE 0 END), 0) AS reconciled_invoices,
                    COALESCE(SUM(CASE WHEN review_status = 'pending'    THEN 1 ELSE 0 END), 0) AS pending_invoices,
                    COALESCE(SUM(CASE WHEN review_status = 'unreviewed' THEN 1 ELSE 0 END), 0) AS unreviewed_invoices
                FROM {DB_SCHEMA}.reconciliation_results
                WHERE company_name = %s
                  AND source_type  = %s
                  AND match_status = 'matched'
            """, (company_name, source_type))
            return cur.fetchone()
    except Exception as e:
        raise Exception(f"Error fetching review status counts: {e}")
    finally:
        conn.close()

def get_reconciled_totals(company_name: str, source_type: str):
    """
    Sum financial fields for records where review_status = 'accepted'.
    These represent the 'reconciled totals' — the subset the user has signed off on.
    """
    conn = get_connection()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(f"""
                SELECT
                    COALESCE(SUM(source_taxable_value), 0) AS taxable_value,
                    COALESCE(SUM(source_cgst), 0)          AS cgst,
                    COALESCE(SUM(source_sgst), 0)          AS sgst,
                    COALESCE(SUM(source_igst), 0)          AS igst,
                    COALESCE(SUM(source_total_amount), 0)  AS total_amount
                FROM {DB_SCHEMA}.reconciliation_results
                WHERE company_name  = %s
                  AND source_type   = %s
                  AND review_status = 'accepted'
            """, (company_name, source_type))
            return cur.fetchone()
    except Exception as e:
        raise Exception(f"Error fetching reconciled totals: {e}")
    finally:
        conn.close()