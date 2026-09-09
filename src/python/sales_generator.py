import json
import sys
import os
from datetime import datetime
from xml.etree.ElementTree import Element, SubElement, tostring
from xml.dom import minidom

if len(sys.argv) >= 2 and sys.argv[1].endswith(".json"):
    with open(sys.argv[1], encoding="utf-8") as f:
        invoice = json.load(f)
else:
    invoice = json.loads(sys.stdin.read())


COMPANY_NAME       = invoice.get("company", "")
sales_ledger       = invoice.get("sales_ledger",       "Sales")
cgst_ledger        = invoice.get("cgst_ledger",        "CGST")
sgst_ledger        = invoice.get("sgst_ledger",        "SGST")
igst_ledger        = invoice.get("igst_ledger",        "IGST")
tds_ledger         = invoice.get("tds_ledger",         "")
cess_ledger        = invoice.get("cess_ledger",        "")
rounded_off_ledger = invoice.get("rounded_off_ledger", "Round Off")

print("invoice_date =", invoice.get("invoice_date"), file=sys.stderr)
print("type =", type(invoice.get("invoice_date")), file=sys.stderr)


def parse_date(d):
    if not d:
        return ""

    if isinstance(d, datetime):
        return d.strftime("%Y%m%d")

    d = str(d).strip()

    formats = [
        "%d-%m-%Y",
        "%Y-%m-%d",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%S.%fZ",
        "%d/%m/%Y",
    ]

    for fmt in formats:
        try:
            return datetime.strptime(d, fmt).strftime("%Y%m%d")
        except ValueError:
            pass

    return d.replace("-", "").replace("/", "")

date     = parse_date(invoice.get("invoice_date", ""))
ref_date = parse_date(invoice.get("reference_date", invoice.get("invoice_date", "")))
print("PARSED DATE =", date, file=sys.stderr)
print("PARSED REF DATE =", ref_date, file=sys.stderr)


invoice_no     = invoice.get("invoice_no", "")
reference      = invoice.get("reference", invoice_no)
party_name     = invoice.get("customer_name", "")
party_gstin    = invoice.get("customer_gstin") or invoice.get("gstin") or ""

# GST registration type:
# GSTIN present  -> Regular
# GSTIN absent  -> Unregistered/Consumer
party_gstin = str(party_gstin).strip()

if party_gstin:
    gst_registration_type = "Regular"
else:
    gst_registration_type = "Unregistered/Consumer"

GST_STATE_MAP = {
    "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab",
    "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana",
    "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh",
    "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh",
    "13": "Nagaland", "14": "Manipur", "15": "Mizoram",
    "16": "Tripura", "17": "Meghalaya", "18": "Assam",
    "19": "West Bengal", "20": "Jharkhand", "21": "Odisha",
    "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
    "25": "Daman & Diu",
    "26": "Dadra & Nagar Haveli and Daman & Diu",
    "27": "Maharashtra", "28": "Andhra Pradesh", "29": "Karnataka", "30": "Goa",
    "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu",
    "34": "Puducherry", "35": "Andaman & Nicobar Islands",
    "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
    "97": "Other Territory", "99": "Centre Jurisdiction",
}

party_state = invoice.get("customer_state") or invoice.get("state") or ""
party_country = invoice.get("customer_country") or invoice.get("country") or "India"

# Fall back to the GSTIN prefix when the frontend did not send a state
if not party_state and party_gstin:
    party_state = GST_STATE_MAP.get(party_gstin[:2], "")

# Some bulk-upload sources (e.g. the Warranty report's ShipToState/
# BillToState columns) send a raw 2-digit GST state CODE instead of a
# state name — confirmed against the actual source file, every row reads
# "23" not "Madhya Pradesh". Pushed as-is, Tally shows a literal "23" for
# both State and Place of Supply on the voucher. Map it through the same
# GST_STATE_MAP used for the GSTIN-prefix fallback above whenever the
# value we have is purely numeric.
if str(party_state).strip().isdigit():
    party_state = GST_STATE_MAP.get(str(party_state).strip().zfill(2), party_state)

place_of_supply = invoice.get("place_of_supply") or party_state or ""

# Place of supply can independently arrive as a raw code too — same fix.
if str(place_of_supply).strip().isdigit():
    place_of_supply = GST_STATE_MAP.get(str(place_of_supply).strip().zfill(2), place_of_supply)

line_items   = invoice.get("line_items", [])
# Round EACH line item first, then sum — matching exactly what gets written
# per-item into the XML below (f"{amount:.2f}" per ALLINVENTORYENTRIES.LIST
# entry). Summing the raw, unrounded amounts and rounding once at the end
# (the previous approach) can differ from this by a paisa whenever a line
# item's own amount lands on a rounding boundary (e.g. 5258.925 rounds to
# 5258.93 per-item, but summing 5258.925 raw with everything else and
# rounding at the end can land on 5258.92-equivalent overall) — that gap
# is exactly what caused real vouchers to reach Tally with debits not
# equal to credits, since this value feeds the round_off balance check.
sales_amount = round(
    sum(round(abs(float(i.get("amount", 0))), 2) for i in line_items),
    2
)

cgst_amount = round(float(invoice.get("cgst_amount", 0)), 2)
sgst_amount = round(float(invoice.get("sgst_amount", 0)), 2)
igst_amount = round(float(invoice.get("igst_amount", 0)), 2)
tds_amount  = abs(round(float(invoice.get("tds_amount",  0)), 2))
cess_amount = round(float(invoice.get("cess_amount", 0)), 2)

# ✅ Frontend sends grand_total as positive (+118)
# abs() ensures it works whether +118 or -118 is sent
grand_total_raw = invoice.get("grand_total")

if grand_total_raw is not None:
    grand_total = round(abs(float(grand_total_raw)), 2)
else:
    grand_total = round(
        abs(
            sales_amount +
            cgst_amount +
            sgst_amount +
            igst_amount -
            tds_amount +
            cess_amount
        ),
        2
    )

# ✅ Round-off: both sides positive, clean math
# ✅ Round Off: taken from Excel (via worker), NOT recalculated — UNLESS the
# incoming value doesn't actually make the voucher balance. A wrong/stale
# round_off (e.g. "0" when the real remainder is a paisa) used to get
# pushed to Tally verbatim, producing a voucher where total debits don't
# equal total credits — Tally accepts the import but later flags it under
# "Mismatch in total amount between Credit and Debit entries", and every
# identical retry just creates another equally-broken duplicate voucher.
# The true remainder needed to balance the voucher, given everything else
# that's about to be posted:
calculated = round(
    sales_amount +
    cgst_amount +
    sgst_amount +
    igst_amount -
    tds_amount +
    cess_amount,
    2
)
true_round_off = round(grand_total - calculated, 2)

round_off_raw = invoice.get("round_off")

if round_off_raw is not None and abs(round(float(round_off_raw), 2) - true_round_off) < 0.01:
    round_off = round(float(round_off_raw), 2)   # matches — pass through as-is
else:
    if round_off_raw is not None:
        print(
            f"WARNING: incoming round_off ({round_off_raw}) does not balance "
            f"this voucher (needs {true_round_off} to make debits equal "
            f"credits) — overriding to {true_round_off} instead of pushing "
            f"an unbalanced voucher to Tally.",
            file=sys.stderr
        )
    round_off = true_round_off
print("sales_amount =", sales_amount, file=sys.stderr)
print("cgst_amount =", cgst_amount, file=sys.stderr)
print("sgst_amount =", sgst_amount, file=sys.stderr)
print("tds_amount =", tds_amount, file=sys.stderr)
print("grand_total =", grand_total, file=sys.stderr)

print(f"DATE        = {date}",           file=sys.stderr)
print(f"PARTY       = {party_name}",     file=sys.stderr)
print(f"SALES AMT   = {sales_amount}",   file=sys.stderr)
print(f"CGST        = {cgst_amount}",    file=sys.stderr)
print(f"SGST        = {sgst_amount}",    file=sys.stderr)
print(f"IGST        = {igst_amount}",    file=sys.stderr)
print(f"GRAND TOTAL = {grand_total}",    file=sys.stderr)
print(f"ROUND OFF   = {round_off}",      file=sys.stderr)
print("================================", file=sys.stderr)

for idx, item in enumerate(line_items, start=1):
    print(
        f"ITEM {idx}: "
        f"{item.get('item_name')} | "
        f"QTY={item.get('quantity')} | "
        f"RATE={item.get('rate')} | "
        f"AMOUNT={item.get('amount')}",
        file=sys.stderr
    )

print("================================", file=sys.stderr)
if not date:
    print("ERROR: invoice_date is empty or could not be parsed", file=sys.stderr)
    sys.exit(1)

def sub(parent, tag, text=""):
    el = SubElement(parent, tag)
    if text:
        el.text = str(text)
    return el

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
vch.set("VCHTYPE", "Sales")
vch.set("ACTION",  "Create")

sub(vch, "DATE",            date)
sub(vch, "VCHSTATUSDATE",   date)
sub(vch, "REFERENCEDATE",   ref_date)
sub(vch, "VOUCHERTYPENAME", "Sales")
sub(vch, "REFERENCE",       reference)
sub(vch, "PARTYNAME",       party_name)
sub(vch, "PARTYLEDGERNAME", party_name)
sub(vch, "GSTREGISTRATIONTYPE", gst_registration_type)

if party_gstin:
    sub(vch, "PARTYGSTIN", party_gstin)
    sub(vch, "CONSIGNEEGSTIN", party_gstin)

if party_state:
    sub(vch, "STATENAME", party_state)
    sub(vch, "CONSIGNEESTATENAME", party_state)

if party_country:
    sub(vch, "COUNTRYOFRESIDENCE", party_country)
    sub(vch, "CONSIGNEECOUNTRYNAME", party_country)

if place_of_supply:
    sub(vch, "PLACEOFSUPPLY", place_of_supply)

sub(vch, "ISINVOICE", "Yes")

narration = invoice.get("narration", "")
if narration:
    sub(vch, "NARRATION", narration)

for item in line_items:
    name   = item.get("item_name") or item.get("name", "")
    qty    = float(item.get("quantity") or item.get("qty") or 1)
    rate   = float(item.get("rate", 0))
    # ✅ abs() — works whether frontend sends +100 or -100
    amount = abs(float(item.get("amount") or (qty * rate)))
    ledger = item.get("ledger") or sales_ledger
    godown = item.get("godown_name") or invoice.get("godown_name")
    description = (item.get("description") or item.get("narration") or "").strip()

    ail = sub(vch, "ALLINVENTORYENTRIES.LIST")

    if description:
        # Must come before STOCKITEMNAME — matches the element order Tally
        # itself uses when exporting a voucher with an item description.
        desc_list = sub(ail, "BASICUSERDESCRIPTION.LIST")
        desc_list.set("TYPE", "String")
        sub(desc_list, "BASICUSERDESCRIPTION", description)

    sub(ail, "STOCKITEMNAME",    name)
    sub(ail, "ISDEEMEDPOSITIVE", "No")
    sub(ail, "RATE",             f"{rate:.2f}")
    sub(ail, "AMOUNT",           f"{amount:.2f}")   # ✅ always +100.00
    sub(ail, "ACTUALQTY",        f"{qty:.2f}")
    sub(ail, "BILLEDQTY",        f"{qty:.2f}")

    if godown:
        sub(ail, "GODOWNNAME", godown)

    aa = sub(ail, "ACCOUNTINGALLOCATIONS.LIST")
    sub(aa, "LEDGERNAME",       ledger)
    sub(aa, "ISDEEMEDPOSITIVE", "No")
    sub(aa, "AMOUNT",           f"{amount:.2f}")    # ✅ always +100.00

# ✅ Party ledger: grand_total minus TDS withheld, always negative for Tally debit
party_amount = round(grand_total, 2)

plel = sub(vch, "LEDGERENTRIES.LIST")
sub(plel, "LEDGERNAME",       party_name)
sub(plel, "ISDEEMEDPOSITIVE", "yes")
sub(plel, "ISPARTYLEDGER",    "Yes")
sub(plel, "AMOUNT",           f"-{party_amount:.2f}")

# ✅ GST: positive with ISDEEMEDPOSITIVE=Yes
if cgst_amount > 0:
    lel = sub(vch, "LEDGERENTRIES.LIST")
    sub(lel, "LEDGERNAME",       cgst_ledger)
    sub(lel, "ISDEEMEDPOSITIVE", "NO")
    sub(lel, "AMOUNT",           f"{cgst_amount:.2f}")

if sgst_amount > 0:
    lel = sub(vch, "LEDGERENTRIES.LIST")
    sub(lel, "LEDGERNAME",       sgst_ledger)
    sub(lel, "ISDEEMEDPOSITIVE", "No")
    sub(lel, "AMOUNT",           f"{sgst_amount:.2f}")

if igst_amount > 0:
    lel = sub(vch, "LEDGERENTRIES.LIST")
    sub(lel, "LEDGERNAME",       igst_ledger)
    sub(lel, "ISDEEMEDPOSITIVE", "NO")
    sub(lel, "AMOUNT",           f"{igst_amount:.2f}")

if tds_amount > 0 and tds_ledger:
    lel = sub(vch, "LEDGERENTRIES.LIST")
    sub(lel, "LEDGERNAME", tds_ledger)
    sub(lel, "ISDEEMEDPOSITIVE", "No")
    sub(lel, "AMOUNT", f"-{tds_amount:.2f}")

if cess_amount > 0 and cess_ledger:
    lel = sub(vch, "LEDGERENTRIES.LIST")
    sub(lel, "LEDGERNAME",       cess_ledger)
    sub(lel, "ISDEEMEDPOSITIVE", "Yes")
    sub(lel, "AMOUNT",           f"{cess_amount:.2f}")

if abs(round_off) >= 0.01:
    lel = sub(vch, "LEDGERENTRIES.LIST")
    sub(lel, "LEDGERNAME",       rounded_off_ledger)
    # Confirmed against real Tally imports (vouchers 124-126): ISDEEMEDPOSITIVE
    # "Yes" makes Tally display a POSITIVE round_off as a subtraction
    # ("(-)0.38" instead of "0.38") regardless of the actual AMOUNT sign —
    # it was flipping the display for no reason. "No" lets the signed
    # AMOUNT value itself (already correct) carry the +/- meaning, for
    # both a positive add and a negative subtract.
    sub(lel, "ISDEEMEDPOSITIVE", "No")
    sub(lel, "AMOUNT",           f"{round_off:.2f}")

# Delivery Challan references — one INVOICEDELNOTES.LIST per challan the
# invoice is billed against. No cap on count; Tally accepts as many as the
# voucher was created against (confirmed against a real Tally XML export —
# these are the "Delivery Note" / "Delivery Note Date" print fields, not
# the Despatch Doc No. fields, and not related to REFERENCE/REFERENCEDATE).
delivery_challans = invoice.get("delivery_challans") or []
for dc in delivery_challans:
    dc_no   = str(dc.get("number") or dc.get("challan_no") or dc.get("dc_no") or "").strip()
    dc_date = parse_date(dc.get("date") or dc.get("challan_date") or dc.get("dc_date"))
    if not dc_no and not dc_date:
        continue
    dn = sub(vch, "INVOICEDELNOTES.LIST")
    if dc_date:
        sub(dn, "BASICSHIPPINGDATE",     dc_date)
    if dc_no:
        sub(dn, "BASICSHIPDELIVERYNOTE", dc_no)

with open("sales_debug.xml", "w", encoding="utf-8") as f:
     f.write(tostring(envelope, encoding="unicode"))

raw    = tostring(envelope, encoding="unicode")
parsed = minidom.parseString(raw)
pretty_bytes = parsed.toprettyxml(indent=" ", encoding="utf-8")

if len(sys.argv) >= 3:
    with open(sys.argv[2], "wb") as f:
        f.write(pretty_bytes)
else:
    sys.stdout.buffer.write(pretty_bytes)