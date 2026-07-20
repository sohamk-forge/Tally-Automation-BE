import json
import sys
import os
from xml.etree.ElementTree import Element, SubElement, tostring
from xml.dom import minidom

# =========================================
# READ JSON
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
        num = 28
    num += 1
    with open(COUNTER_FILE, "w") as f:
        f.write(str(num))
    return str(num)

if "voucher_number" not in invoice:
    invoice["voucher_number"] = get_next_voucher_number()

# =========================================
# COMPANY
# =========================================
COMPANY_NAME = invoice.get("company") or invoice.get("company_name", "")

# =========================================
# DYNAMIC LEDGER NAMES
# =========================================
purchase_ledger = invoice.get("purchase_ledger", "")
cgst_ledger = invoice.get("cgst_ledger", "")
sgst_ledger = invoice.get("sgst_ledger", "")
igst_ledger = invoice.get("igst_ledger", "")
tds_ledger         = invoice.get("tds_ledger",         "")
cess_ledger        = invoice.get("cess_ledger",        "")
rounded_off_ledger = invoice.get("rounded_off_ledger", "")

# =========================================
# DEBUG: Print ledger mappings
# =========================================
print("=" * 50, file=sys.stderr)
print("LEDGER MAPPINGS:", file=sys.stderr)
print(f"  purchase_ledger    : '{purchase_ledger}'", file=sys.stderr)
print(f"  cgst_ledger        : '{cgst_ledger}'", file=sys.stderr)
print(f"  sgst_ledger        : '{sgst_ledger}'", file=sys.stderr)
print(f"  igst_ledger        : '{igst_ledger}'", file=sys.stderr)
print(f"  tds_ledger         : '{tds_ledger}'", file=sys.stderr)
print(f"  cess_ledger        : '{cess_ledger}'", file=sys.stderr)
print(f"  rounded_off_ledger : '{rounded_off_ledger}'", file=sys.stderr)
print("=" * 50, file=sys.stderr)

# =========================================
# DATE - YYYYMMDD (Tally format)
# =========================================
def parse_date(d):
    if not d:
        return ""
    d = str(d).strip()

    if "-" in d or "/" in d:
        parts = d.replace("/", "-").split("-")
        if len(parts) == 3:
            if len(parts[0]) == 2:      # DD-MM-YYYY
                day, mon, yr = parts[0], parts[1], parts[2]
            elif len(parts[0]) == 4:    # YYYY-MM-DD
                yr, mon, day = parts[0], parts[1], parts[2]
            return f"{yr}{mon}{day}"    # → 20260310

    if len(d) == 8 and d.isdigit():     # already YYYYMMDD
        return d

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
party_gstin    = invoice.get("vendor_gstin") or invoice.get("gstin") or ""
narration      = invoice.get("narration", f"Being purchase from {party_name} vide invoice {invoice_no} dated {invoice.get('invoice_date', '')}")

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

calculated = round(purchase_amount + cgst_amount + sgst_amount + igst_amount, 2)
round_off  = round(grand_total - calculated, 2)

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

header = sub(envelope, "HEADER")
sub(header, "VERSION",      "1")
sub(header, "TALLYREQUEST", "Import")
sub(header, "TYPE",         "Data")
sub(header, "ID",           "Vouchers")

body = sub(envelope, "BODY")
desc = sub(body, "DESC")

sv = sub(desc, "STATICVARIABLES")
sub(sv, "SVVCHIMPORTFORMAT", "XML")
sub(sv, "SVCURRENTCOMPANY",  COMPANY_NAME)

tm = sub(desc, "TALLYMESSAGE")
tm.set("xmlns:UDF", "TallyUDF")

vch = sub(tm, "VOUCHER")
vch.set("VCHTYPE", "Purchase")
vch.set("ACTION",  "Create")

sub(vch, "DATE",                        date)
sub(vch, "VCHSTATUSDATE",               date)
sub(vch, "REFERENCEDATE",               ref_date)
sub(vch, "VOUCHERTYPENAME",             "Purchase")
# sub(vch, "VOUCHERNUMBER",               voucher_number)
sub(vch, "REFERENCE",                   reference)
sub(vch, "PARTYNAME",                   party_name)
sub(vch, "PARTYLEDGERNAME",             party_name)
sub(vch, "PARTYGSTIN",                  party_gstin)
sub(vch, "ISINVOICE",                   "Yes")
# sub(vch, "PURCHASELED",                 purchase_ledger)  # ✅ fills Purchase Ledger field
sub(vch, "NARRATION",                   narration)        # ✅ fills Narration field

# =========================================
# INVENTORY ENTRIES
# =========================================
for item in line_items:
    # FIXED: Use item_name or name (both supported)
    name   = item.get("item_name") or item.get("name", "")
    qty    = float(item.get("qty", 1))
    unit               = item.get("unit", "") 
    rate   = float(item.get("rate", 0))
    amount = float(item.get("amount", 0))
    # FIXED: Use item ledger or purchase_ledger
    ledger = item.get("ledger") or purchase_ledger
    godown = item.get("godown_name") or invoice.get("godown_name") or ""

    # DEBUG: Print item details
    print("=" * 50, file=sys.stderr)
    print(f"ITEM NAME = {name}", file=sys.stderr)
    print(f"LEDGER = {ledger}", file=sys.stderr)
    print(f"DATE = {date}", file=sys.stderr)
    print(f"QTY = {qty}, RATE = {rate}, AMOUNT = {amount}", file=sys.stderr)
    print("=" * 50, file=sys.stderr)

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
    sub(aa, "LEDGERNAME",       ledger)
    sub(aa, "ISDEEMEDPOSITIVE", "Yes")
    sub(aa, "AMOUNT",           str(-amount))

# =========================================
# LEDGER ENTRIES
# =========================================

# Party (Credit)
plel = sub(vch, "LEDGERENTRIES.LIST")
sub(plel, "LEDGERNAME",       party_name)
sub(plel, "ISDEEMEDPOSITIVE", "No")
sub(plel, "ISPARTYLEDGER",    "Yes")
sub(plel, "AMOUNT",           str(grand_total))

# CGST (Debit)
if cgst_amount > 0:
    lel = sub(vch, "LEDGERENTRIES.LIST")
    sub(lel, "LEDGERNAME",       cgst_ledger)
    sub(lel, "ISDEEMEDPOSITIVE", "Yes")
    sub(lel, "AMOUNT",           str(-cgst_amount))

# SGST (Debit)
if sgst_amount > 0:
    lel = sub(vch, "LEDGERENTRIES.LIST")
    sub(lel, "LEDGERNAME",       sgst_ledger)
    sub(lel, "ISDEEMEDPOSITIVE", "Yes")
    sub(lel, "AMOUNT",           str(-sgst_amount))

# IGST (Debit)
if igst_amount > 0:
    lel = sub(vch, "LEDGERENTRIES.LIST")
    sub(lel, "LEDGERNAME",       igst_ledger)
    sub(lel, "ISDEEMEDPOSITIVE", "Yes")
    sub(lel, "AMOUNT",           str(-igst_amount))

# TDS (Debit - assuming it's an expense/asset)
if tds_amount > 0 and tds_ledger:
    lel = sub(vch, "LEDGERENTRIES.LIST")
    sub(lel, "LEDGERNAME",       tds_ledger)
    sub(lel, "ISDEEMEDPOSITIVE", "Yes")
    sub(lel, "AMOUNT",           str(-tds_amount))

# CESS (Debit)
if cess_amount > 0 and cess_ledger:
    lel = sub(vch, "LEDGERENTRIES.LIST")
    sub(lel, "LEDGERNAME",       cess_ledger)
    sub(lel, "ISDEEMEDPOSITIVE", "Yes")
    sub(lel, "AMOUNT",           str(-cess_amount))

# Round Off
if abs(round_off) >= 0.01:
    lel = sub(vch, "LEDGERENTRIES.LIST")
    sub(lel, "LEDGERNAME",       rounded_off_ledger)
    sub(lel, "ISDEEMEDPOSITIVE", "Yes")
    sub(lel, "AMOUNT",           str(-round_off))

# =========================================
# OUTPUT
# =========================================
raw    = tostring(envelope, encoding="unicode")
parsed = minidom.parseString(raw)
pretty = parsed.toprettyxml(indent=" ")

# Remove XML declaration if present (Tally doesn't like it)
if pretty.startswith('<?xml'):
    pretty = pretty.split('\n', 1)[1]

if len(sys.argv) >= 3:
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        f.write(pretty)
    print(f"✅ XML saved to: {sys.argv[2]}", file=sys.stderr)
else:
    sys.stdout.write(pretty)