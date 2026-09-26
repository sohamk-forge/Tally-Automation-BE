import xml.etree.ElementTree as ET
from xml.dom import minidom
import requests
import json
import sys


class VoucherGenerator:

    def __init__(self, data):
        self.data = data

    def prettify_xml(self, elem):

        rough_string = ET.tostring(
            elem,
            encoding="utf-8"
        )

        reparsed = minidom.parseString(
            rough_string
        )

        return reparsed.toprettyxml(
            indent="    ",
            encoding="utf-8"
        ).decode("utf-8")

    def add_bank_allocation(
        self,
        parent,
        bank_data,
        amount
    ):

        bank_alloc = ET.SubElement(
            parent,
            "BANKALLOCATIONS.LIST"
        )

        ET.SubElement(
            bank_alloc,
            "DATE"
        ).text = self.data["date"]

        ET.SubElement(
            bank_alloc,
            "INSTRUMENTDATE"
        ).text = self.data["date"]

        ET.SubElement(
            bank_alloc,
            "TRANSACTIONTYPE"
        ).text = bank_data.get(
            "transaction_type",
            "Cheque/DD"
        )

        ET.SubElement(
            bank_alloc,
            "BANKNAME"
        ).text = bank_data.get(
            "bank_name",
            ""
        )

        ET.SubElement(
            bank_alloc,
            "PAYMENTFAVOURING"
        ).text = bank_data.get(
            "party_name",
            ""
        )

        ET.SubElement(
            bank_alloc,
            "INSTRUMENTNUMBER"
        ).text = bank_data.get(
            "instrument_number",
            ""
        )

        ET.SubElement(
            bank_alloc,
            "PAYMENTMODE"
        ).text = bank_data.get(
            "payment_mode",
            "Transacted"
        )

        ET.SubElement(
            bank_alloc,
            "BANKPARTYNAME"
        ).text = bank_data.get(
            "party_name",
            ""
        )

        ET.SubElement(
            bank_alloc,
            "ISCONNECTEDPAYMENT"
        ).text = "No"

        ET.SubElement(
            bank_alloc,
            "AMOUNT"
        ).text = f"{amount:.2f}"

    def generate_xml(self):

        root = ET.Element(
            "ENVELOPE"
        )

        header = ET.SubElement(
            root,
            "HEADER"
        )

        ET.SubElement(
            header,
            "VERSION"
        ).text = "1"

        ET.SubElement(
            header,
            "TALLYREQUEST"
        ).text = "Import"

        ET.SubElement(
            header,
            "TYPE"
        ).text = "Data"

        ET.SubElement(
            header,
            "ID"
        ).text = "Vouchers"

        body = ET.SubElement(
            root,
            "BODY"
        )

        desc = ET.SubElement(
            body,
            "DESC"
        )

        static_vars = ET.SubElement(
            desc,
            "STATICVARIABLES"
        )

        ET.SubElement(
            static_vars,
            "SVVCHIMPORTFORMAT"
        ).text = "XML"

        ET.SubElement(
            static_vars,
            "SVCURRENTCOMPANY"
        ).text = self.data["company"]

        data_node = ET.SubElement(
            body,
            "DATA"
        )

        tally_message = ET.SubElement(
            data_node,
            "TALLYMESSAGE"
        )

        tally_message.set(
            "xmlns:UDF",
            "TallyUDF"
        )

        voucher = ET.SubElement(
            tally_message,
            "VOUCHER"
        )

        voucher_type = (
            self.data["voucher_type"]
            .capitalize()
        )

        voucher.set(
            "VCHTYPE",
            voucher_type
        )

        voucher.set(
            "ACTION",
            "Create"
        )

        voucher.set(
            "OBJVIEW",
            "Accounting Voucher View"
        )

        ET.SubElement(
            voucher,
            "DATE"
        ).text = self.data["date"]

        ET.SubElement(
            voucher,
            "VOUCHERTYPENAME"
        ).text = voucher_type

        ET.SubElement(
            voucher,
            "VOUCHERNUMBER"
        ).text = str(
            self.data["voucher_number"]
        )

        ET.SubElement(
            voucher,
            "PARTYLEDGERNAME"
        ).text = self.data[
            "party_ledger"
        ]

        ET.SubElement(
            voucher,
            "NARRATION"
        ).text = self.data[
            "narration"
        ]

        for ledger in self.data[
            "ledgers"
        ]:

            entry = ET.SubElement(
                voucher,
                "ALLLEDGERENTRIES.LIST"
            )

            ET.SubElement(
                entry,
                "LEDGERNAME"
            ).text = ledger[
                "ledger_name"
            ]

            ET.SubElement(
                entry,
                "ISDEEMEDPOSITIVE"
            ).text = (
                "Yes"
                if ledger[
                    "is_positive"
                ]
                else "No"
            )

            ET.SubElement(
                entry,
                "ISPARTYLEDGER"
            ).text = "Yes"

            amount = float(
                ledger["amount"]
            )

            ET.SubElement(
                entry,
                "AMOUNT"
            ).text = (
                f"{amount:.2f}"
            )

            if ledger.get(
                "bank_allocation"
            ):

                self.add_bank_allocation(
                    entry,
                    ledger[
                        "bank_allocation"
                    ],
                    amount
                )

        return self.prettify_xml(
            root
        )




# ==========================
# TAKE DATA FROM NODE
# ==========================

payload = json.loads(
    sys.argv[1]
)

generator = VoucherGenerator(
    payload
)

xml_output = (
    generator.generate_xml()
)

print(xml_output)

