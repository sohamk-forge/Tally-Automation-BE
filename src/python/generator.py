import json
import sys
from xml.etree.ElementTree import Element, SubElement, tostring
from xml.dom import minidom

# =========================================
# READ JSON
# =========================================
# Usage:
#   python script.py invoice.json output.xml
#   python script.py < invoice.json > output.xml
if len(sys.argv) >= 2 and sys.argv[1].endswith(".json"):
    with open(sys.argv[1], encoding="utf-8") as f:
        invoice = json.load(f)
else:
    invoice = json.loads(sys.stdin.read())

# =========================================
# AUTO INCREMENT VOUCHER NUMBER
# =========================================
import os

COUNTER_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voucher_counter.txt")

def get_next_voucher_number():
    if os.path.exists(COUNTER_FILE):
        with open(COUNTER_FILE, "r") as f:
            num = int(f.read().strip())
    else:
        num = 28  # starts at 28, first run gives 29
    num += 1
    with open(COUNTER_FILE, "w") as f:
        f.write(str(num))
    return str(num)

# Use voucher_number from JSON if provided, else auto-increment
if "voucher_number" not in invoice:
    invoice["voucher_number"] = get_next_voucher_number()

# =========================================
# COMPANY
# =========================================
COMPANY_NAME = invoice.get("company", "SAI COMPUTECH (24-25) - (from 1-Apr-24)")

# =========================================
# DATE  (DD-MM-YYYY or YYYYMMDD)
# =========================================
def parse_date(d):
    if not d:
        return ""
    if "-" in d:
        parts = d.split("-")
        if len(parts[0]) == 4:
            return d.replace("-", "")
        else:
            day, mon, yr = parts
            return f"{yr}{mon}{day}"
    return d

date     = parse_date(invoice.get("invoice_date", ""))
ref_date = parse_date(invoice.get("reference_date", invoice.get("invoice_date", "")))

# =========================================
# VOUCHER FIELDS
# =========================================
voucher_number = str(invoice.get("voucher_number", ""))
invoice_no     = invoice.get("invoice_no", "")
reference      = invoice.get("reference", invoice_no)
party_name     = invoice.get("vendor_name", "")
party_gstin    = invoice.get("vendor_gstin", "")

# =========================================
# AMOUNTS
# =========================================
line_items      = invoice.get("line_items", [])
purchase_amount = round(sum(float(i.get("amount", 0)) for i in line_items), 2)
cgst            = round(float(invoice.get("cgst_amount", 0)), 2)
sgst            = round(float(invoice.get("sgst_amount", 0)), 2)
grand_total     = round(float(invoice.get("grand_total", 0)), 2)
calculated      = round(purchase_amount + cgst + sgst, 2)
round_off       = round(grand_total - calculated, 2)

# =========================================
# HELPER
# =========================================
def sub(parent, tag, text=""):
    el = SubElement(parent, tag)
    if text:
        el.text = str(text)
    return el

# =========================================
# BUILD XML
# =========================================
envelope = Element("ENVELOPE")

# Header
header = sub(envelope, "HEADER")
sub(header, "VERSION",      "1")
sub(header, "TALLYREQUEST", "Import")
sub(header, "TYPE",         "Data")
sub(header, "ID",           "Vouchers")

# Body
body = sub(envelope, "BODY")
desc = sub(body, "DESC")

sv = sub(desc, "STATICVARIABLES")
sub(sv, "SVVCHIMPORTFORMAT", "XML")
sub(sv, "SVCURRENTCOMPANY",  COMPANY_NAME)

# TallyMessage
tm = sub(desc, "TALLYMESSAGE")
tm.set("xmlns:UDF", "TallyUDF")

# Voucher
vch = sub(tm, "VOUCHER")
vch.set("VCHTYPE", "Purchase")
vch.set("ACTION",  "Create")

sub(vch, "DATE",            date)
sub(vch, "VCHSTATUSDATE",   date)
sub(vch, "REFERENCEDATE",   ref_date)
sub(vch, "VOUCHERTYPENAME", "Purchase")
sub(vch, "VOUCHERNUMBER",   voucher_number)
sub(vch, "REFERENCE",       reference)
sub(vch, "PARTYNAME",       party_name)
sub(vch, "PARTYLEDGERNAME", party_name)
sub(vch, "PARTYGSTIN",      party_gstin)
sub(vch, "ISINVOICE",       "Yes")

# =========================================
# INVENTORY ENTRIES
# =========================================
for item in line_items:
    name   = item.get("name", "")
    qty    = float(item.get("qty", 1))
    unit   = item.get("unit", "nos")
    rate   = float(item.get("rate", 0))
    amount = float(item.get("amount", 0))
    ledger = item.get("ledger", "GST Purchase")

    ail = sub(vch, "ALLINVENTORYENTRIES.LIST")
    sub(ail, "STOCKITEMNAME",   name)
    sub(ail, "ISDEEMEDPOSITIVE","Yes")
    sub(ail, "RATE",            f"{rate}/{unit}")
    sub(ail, "AMOUNT",          str(-amount))
    sub(ail, "ACTUALQTY",       f"{qty} {unit}")
    sub(ail, "BILLEDQTY",       f"{qty} {unit}")

    aa = sub(ail, "ACCOUNTINGALLOCATIONS.LIST")
    sub(aa, "LEDGERNAME",       ledger)
    sub(aa, "ISDEEMEDPOSITIVE", "Yes")
    sub(aa, "AMOUNT",           str(-amount))

# =========================================
# LEDGER ENTRIES
# Order: Party → CGST → SGST → Roundoff
# =========================================

# Party — positive (credit)
plel = sub(vch, "LEDGERENTRIES.LIST")
sub(plel, "LEDGERNAME",      party_name)
sub(plel, "ISDEEMEDPOSITIVE","No")
sub(plel, "ISPARTYLEDGER",   "Yes")
sub(plel, "AMOUNT",          str(grand_total))

# CGST — negative (debit)
if cgst > 0:
    lel = sub(vch, "LEDGERENTRIES.LIST")
    sub(lel, "LEDGERNAME",      "CGST")
    sub(lel, "ISDEEMEDPOSITIVE","Yes")
    sub(lel, "AMOUNT",          str(-cgst))

# SGST — negative (debit)
if sgst > 0:
    lel = sub(vch, "LEDGERENTRIES.LIST")
    sub(lel, "LEDGERNAME",      "SGST")
    sub(lel, "ISDEEMEDPOSITIVE","Yes")
    sub(lel, "AMOUNT",          str(-sgst))

# Roundoff
if round_off != 0:
    lel = sub(vch, "LEDGERENTRIES.LIST")
    sub(lel, "LEDGERNAME",      "Rounded Off")
    sub(lel, "ISDEEMEDPOSITIVE","Yes")
    sub(lel, "AMOUNT",          str(-round_off))

# =========================================
# OUTPUT
# =========================================
raw = tostring(envelope, encoding="unicode")
parsed = minidom.parseString(raw)

pretty_bytes = parsed.toprettyxml(
    indent=" ",
    encoding="utf-8"
)

if len(sys.argv) >= 3:
    with open(sys.argv[2], "wb") as f:
        f.write(pretty_bytes)
else:
    sys.stdout.buffer.write(pretty_bytes)
