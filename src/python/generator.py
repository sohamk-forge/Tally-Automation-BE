import json
import sys
import os
from xml.etree.ElementTree import Element, SubElement, tostring
from xml.dom import minidom

# =========================================
# READ JSON
# Usage:
#   python generator.py invoice.json output.xml
#   python generator.py < invoice.json
# =========================================
if len(sys.argv) >= 2 and sys.argv[1].endswith(".json"):
    with open(sys.argv[1], encoding="utf-8") as f:
        invoice = json.load(f)
else:
    invoice = json.loads(sys.stdin.read())

# =========================================
# AUTO INCREMENT VOUCHER NUMBER
# =========================================
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

if "voucher_number" not in invoice:
    invoice["voucher_number"] = get_next_voucher_number()

# =========================================
# COMPANY
# =========================================
COMPANY_NAME = invoice.get("company", "")

# =========================================
# DYNAMIC LEDGER NAMES
# All values come from worker (company_ledger_mappings table)
# Fallbacks are safety nets only — worker always provides these
# =========================================
purchase_ledger    = invoice.get("purchase_ledger",    "Purchase")
cgst_ledger        = invoice.get("cgst_ledger",        "CGST")
sgst_ledger        = invoice.get("sgst_ledger",        "SGST")
igst_ledger        = invoice.get("igst_ledger",        "IGST")
tds_ledger         = invoice.get("tds_ledger",         "")
cess_ledger        = invoice.get("cess_ledger",        "")
rounded_off_ledger = invoice.get("rounded_off_ledger", "Round Off")

# =========================================
# DATE  (DD-MM-YYYY → YYYYMMDD)
# =========================================
def parse_date(d):
    if not d:
        return ""
    if "-" in d:
        parts = d.split("-")
        if len(parts[0]) == 4:          # already YYYY-MM-DD
            return d.replace("-", "")
        else:                           # DD-MM-YYYY
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
party_gstin    = (
    invoice.get("vendor_gstin")
    or invoice.get("gstin")
    or ""
)

# =========================================
# AMOUNTS
# =========================================
line_items      = invoice.get("line_items", [])
purchase_amount = round(sum(float(i.get("amount", 0)) for i in line_items), 2)
cgst_amount     = round(float(invoice.get("cgst_amount", 0)), 2)
sgst_amount     = round(float(invoice.get("sgst_amount", 0)), 2)
igst_amount     = round(float(invoice.get("igst_amount", 0)), 2)
tds_amount      = round(float(invoice.get("tds_amount",  0)), 2)
cess_amount     = round(float(invoice.get("cess_amount", 0)), 2)
grand_total     = round(float(invoice.get("grand_total", 0)), 2)

calculated = round(
    purchase_amount + cgst_amount + sgst_amount + igst_amount,
    2
)
round_off = round(grand_total - calculated, 2)

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
    name   = item.get("item_name") or item.get("name", "")
    qty    = float(item.get("qty", 1))
    unit   = item.get("unit", "nos")
    rate   = float(item.get("rate", 0))
    amount = float(item.get("amount", 0))

    # ✅ Dynamic: comes from item.ledger (set by worker from mapping table)
    # Falls back to purchase_ledger (also dynamic, from mapping table)
    ledger = item.get("ledger") or purchase_ledger
    godown = (
    item.get("godown_name")
    or invoice.get("godown_name")
    or ""
)

    ail = sub(vch, "ALLINVENTORYENTRIES.LIST")
    sub(ail, "STOCKITEMNAME",    name)
    sub(ail, "ISDEEMEDPOSITIVE", "Yes")
    sub(ail, "RATE",             f"{rate}/{unit}")
    sub(ail, "AMOUNT",           str(-amount))
    sub(ail, "ACTUALQTY",        f"{qty} {unit}")
    sub(ail, "BILLEDQTY",        f"{qty} {unit}")
if godown:
    sub(ail, "GODOWNNAME", godown)

    aa = sub(ail, "ACCOUNTINGALLOCATIONS.LIST")
    sub(aa, "LEDGERNAME",        ledger)           # ✅ dynamic
    sub(aa, "ISDEEMEDPOSITIVE",  "Yes")
    sub(aa, "AMOUNT",            str(-amount))

# =========================================
# LEDGER ENTRIES
# Order: Party → CGST → SGST → IGST → TDS → CESS → Round Off
# =========================================

# Party — credit (ISDEEMEDPOSITIVE = No)
plel = sub(vch, "LEDGERENTRIES.LIST")
sub(plel, "LEDGERNAME",       party_name)
sub(plel, "ISDEEMEDPOSITIVE", "No")
sub(plel, "ISPARTYLEDGER",    "Yes")
sub(plel, "AMOUNT",           str(grand_total))

# CGST — debit
if cgst_amount > 0:
    lel = sub(vch, "LEDGERENTRIES.LIST")
    sub(lel, "LEDGERNAME",       cgst_ledger)      # ✅ dynamic
    sub(lel, "ISDEEMEDPOSITIVE", "Yes")
    sub(lel, "AMOUNT",           str(-cgst_amount))

# SGST — debit
if sgst_amount > 0:
    lel = sub(vch, "LEDGERENTRIES.LIST")
    sub(lel, "LEDGERNAME",       sgst_ledger)      # ✅ dynamic
    sub(lel, "ISDEEMEDPOSITIVE", "Yes")
    sub(lel, "AMOUNT",           str(-sgst_amount))

# IGST — debit
if igst_amount > 0:
    lel = sub(vch, "LEDGERENTRIES.LIST")
    sub(lel, "LEDGERNAME",       igst_ledger)      # ✅ dynamic
    sub(lel, "ISDEEMEDPOSITIVE", "Yes")
    sub(lel, "AMOUNT",           str(-igst_amount))

# TDS — debit (only if mapped and non-zero)
if tds_amount > 0 and tds_ledger:
    lel = sub(vch, "LEDGERENTRIES.LIST")
    sub(lel, "LEDGERNAME",       tds_ledger)       # ✅ dynamic
    sub(lel, "ISDEEMEDPOSITIVE", "Yes")
    sub(lel, "AMOUNT",           str(-tds_amount))

# CESS — debit (only if mapped and non-zero)
if cess_amount > 0 and cess_ledger:
    lel = sub(vch, "LEDGERENTRIES.LIST")
    sub(lel, "LEDGERNAME",       cess_ledger)      # ✅ dynamic
    sub(lel, "ISDEEMEDPOSITIVE", "Yes")
    sub(lel, "AMOUNT",           str(-cess_amount))

# Round Off — debit (only if meaningful difference)
if abs(round_off) >= 0.01:
    lel = sub(vch, "LEDGERENTRIES.LIST")
    sub(lel, "LEDGERNAME",       rounded_off_ledger)  # ✅ dynamic
    sub(lel, "ISDEEMEDPOSITIVE", "Yes")
    sub(lel, "AMOUNT",           str(-round_off))

# =========================================
# OUTPUT
# =========================================
raw    = tostring(envelope, encoding="unicode")
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