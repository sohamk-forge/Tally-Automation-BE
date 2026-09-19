from datetime import datetime
import pandas as pd

def clean_string(value):
    if pd.isna(value):
        return ""
    return str(value).strip()

def clean_amount(value):
    if pd.isna(value):
        return 0.0
    try:
        return round(float(value), 2)
    except:
        return 0.0

def clean_date(value):
    if pd.isna(value):
        return ""
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d")
    try:
        return pd.to_datetime(value).strftime("%Y-%m-%d")
    except:
        return str(value)

def build_key(gstin, invoice_no, invoice_date):
    return (
        clean_string(gstin).upper(),
        clean_string(invoice_no).upper(),
        clean_date(invoice_date)
    )

def filter_by_date_range(records, date_field, month=None, year=None, from_date=None, to_date=None):
    if from_date and to_date:
        range_start = pd.to_datetime(from_date)
        range_end = pd.to_datetime(to_date)
    elif month is not None and year is not None:
        range_start = pd.Timestamp(year=year, month=month, day=1)
        range_end = range_start + pd.offsets.MonthEnd(0)
    else:
        return records

    filtered = []
    for record in records:
        record_date = pd.to_datetime(record[date_field], errors="coerce")
        if pd.isna(record_date):
            continue
        if range_start <= record_date <= range_end:
            filtered.append(record)
    return filtered

def calculate_variance(excel, tally):
    variance = 0
    variance += abs(excel["taxable_value"] - tally["taxable_value"])
    variance += abs(excel["cgst"] - tally["cgst"])
    variance += abs(excel["sgst"] - tally["sgst"])
    variance += abs(excel["igst"] - tally["igst"])
    return round(variance, 2)