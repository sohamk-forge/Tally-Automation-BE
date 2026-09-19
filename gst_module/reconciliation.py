import logging
from collections import defaultdict

logger = logging.getLogger(__name__)
from gst_module.config import (
    STATUS_MATCHED,
    STATUS_PARTIALLY_MATCHED,
    STATUS_NOT_IN_TALLY,
    STATUS_NOT_IN_EXCEL,
    STATUS_VARIANCE
)
from gst_module.utils import (
    calculate_variance
)
class ReconciliationEngine:
    def __init__(self, excel_data, tally_data, source_label="gstr2b"):
        self.excel_data = excel_data
        self.tally_data = tally_data
        # Prefixes the excel-side keys in the output (e.g. "gstr2b_taxable_value"
        # vs "cdn_taxable_value") so the same engine reads sensibly for both the
        # GSTR-2B invoice reconciliation and the GSTR2B_CDN CDN debit note reconciliation.
        self.source_label = source_label

    def reconcile(self):

        records = []
        matched_records = []
        missing_in_tally_records = []
        missing_in_excel_records = []
        partially_matched_records = []
        matched = 0
        partially_matched_invoices = 0
        not_present_in_tally = 0
        not_present_in_excel = 0
        total_variance = 0

        # Accumulators for matched_totals
        matched_taxable = 0.0
        matched_cgst = 0.0
        matched_sgst = 0.0
        matched_igst = 0.0
        matched_total = 0.0

        tally_dict = {}
        for voucher in self.tally_data:
            key = (
                voucher["invoice_no"].upper(),
                voucher["invoice_date"]
            )

            tally_dict.setdefault(key, voucher)

        logger.info("Built tally lookup with %s unique keys", len(tally_dict))

        matched_tally_ids = set()
        pass1_pairs = []      # (invoice, tally, match_type)
        pending_excel = []    # invoices not resolved by pass 1

        excel_sorted = sorted(self.excel_data, key=lambda x: x["invoice_date"])
        for invoice in excel_sorted:
            key = (
                invoice["invoice_no"].upper(),
                invoice["invoice_date"]
            )
            tally = tally_dict.get(key)
            if tally is not None and id(tally) not in matched_tally_ids:
                matched_tally_ids.add(id(tally))
                pass1_pairs.append((invoice, tally, "invoice_no"))
            else:
                pending_excel.append(invoice)

        remaining_tally = sorted(
            (v for v in self.tally_data if id(v) not in matched_tally_ids),
            key=lambda x: x["invoice_date"]
        )
        amount_buckets = defaultdict(list)
        for voucher in remaining_tally:
            amount_buckets[round(voucher["total_amount"])].append(voucher)

        pass2_pairs = []
        still_pending_excel = []
        for invoice in pending_excel:
            bucket = amount_buckets.get(round(invoice["total_amount"]))
            if bucket:
                tally = bucket.pop(0)
                matched_tally_ids.add(id(tally))
                pass2_pairs.append((invoice, tally, "amount"))
            else:
                still_pending_excel.append(invoice)

        for invoice, tally, match_type in pass1_pairs + pass2_pairs:
            logger.debug(
                "Comparing invoice %s | %s (matched by %s)",
                invoice.get("invoice_no"), invoice.get("invoice_date"), match_type
            )
            variance = calculate_variance(invoice, tally)
            total_variance += variance

            if variance > 0:
                status = STATUS_PARTIALLY_MATCHED
                match_status = "partially_matched"
                partially_matched_invoices += 1
                logger.info(
                    "Variance found for invoice %s | %s with variance=%s",
                    invoice.get("invoice_no"), invoice.get("invoice_date"), variance
                )
                partially_matched_records.append({
                    "gstin": invoice["gstin"],
                    "party_name": invoice["customer_name"],
                    "invoice_no": invoice["invoice_no"],
                    "invoice_date": invoice["invoice_date"],
                    "matched_by": match_type,
                    "match_status": match_status,
                    "review_status": "unreviewed",

                    # Normalized keys for DB upsert
                    "source_taxable_value": invoice["taxable_value"],
                    "source_cgst": invoice["cgst"],
                    "source_sgst": invoice["sgst"],
                    "source_igst": invoice["igst"],
                    "source_total_amount": invoice["total_amount"],

                    # Excel-side values (GSTR-2B invoice, or GSTR2B_CDN CDN note, etc.)
                    f"{self.source_label}_taxable_value": invoice["taxable_value"],
                    f"{self.source_label}_cgst": invoice["cgst"],
                    f"{self.source_label}_sgst": invoice["sgst"],
                    f"{self.source_label}_igst": invoice["igst"],
                    f"{self.source_label}_total_amount": invoice["total_amount"],

                    # Tally Values
                    "tally_taxable_value": tally["taxable_value"],
                    "tally_cgst": tally["cgst"],
                    "tally_sgst": tally["sgst"],
                    "tally_igst": tally["igst"],
                    "tally_total_amount": tally["total_amount"],

                    # Field-wise Difference
                    "taxable_difference": round(abs(invoice["taxable_value"] - tally["taxable_value"]), 2),
                    "cgst_difference": round(abs(invoice["cgst"] - tally["cgst"]), 2),
                    "sgst_difference": round(abs(invoice["sgst"] - tally["sgst"]), 2),
                    "igst_difference": round(abs(invoice["igst"] - tally["igst"]), 2),
                    "total_difference": variance
                })
            else:
                status = STATUS_MATCHED
                match_status = "matched"
                matched += 1

                # Accumulate matched totals
                matched_taxable += invoice["taxable_value"]
                matched_cgst += invoice["cgst"]
                matched_sgst += invoice["sgst"]
                matched_igst += invoice["igst"]
                matched_total += invoice["total_amount"]

                logger.debug(
                    "Matched invoice %s | %s (by %s)",
                    invoice.get("invoice_no"), invoice.get("invoice_date"), match_type
                )

                matched_records.append({
                    "gstin": invoice["gstin"],
                    "party_name": invoice["customer_name"],
                    "invoice_no": invoice["invoice_no"],
                    "invoice_date": invoice["invoice_date"],
                    "matched_by": match_type,
                    "match_status": match_status,
                    "review_status": "unreviewed",

                    # Normalized keys for DB upsert
                    "source_taxable_value": invoice["taxable_value"],
                    "source_cgst": invoice["cgst"],
                    "source_sgst": invoice["sgst"],
                    "source_igst": invoice["igst"],
                    "source_total_amount": invoice["total_amount"],

                    # Excel-side values
                    f"{self.source_label}_taxable_value": invoice["taxable_value"],
                    f"{self.source_label}_cgst": invoice["cgst"],
                    f"{self.source_label}_sgst": invoice["sgst"],
                    f"{self.source_label}_igst": invoice["igst"],
                    f"{self.source_label}_total_amount": invoice["total_amount"],

                    # Tally Values
                    "tally_taxable_value": tally["taxable_value"],
                    "tally_cgst": tally["cgst"],
                    "tally_sgst": tally["sgst"],
                    "tally_igst": tally["igst"],
                    "tally_total_amount": tally["total_amount"],
                })

            records.append({
                "customer_name": invoice["customer_name"],
                "gstin": invoice["gstin"],
                "invoice_no": invoice["invoice_no"],
                "invoice_date": invoice["invoice_date"],
                "taxable_value": invoice["taxable_value"],
                "cgst": invoice["cgst"],
                "sgst": invoice["sgst"],
                "igst": invoice["igst"],
                "total_amount": invoice["total_amount"],
                "variance": variance,
                "status": status,
                "match_status": match_status,
                "review_status": "unreviewed",
                "matched_by": match_type
            })

        # ---- Whatever's left on the excel side is genuinely not in Tally ----
        for invoice in still_pending_excel:
            variance = invoice["total_amount"]
            logger.info(
                "Invoice missing in tally: %s | %s",
                invoice.get("invoice_no"), invoice.get("invoice_date")
            )
            total_variance += variance
            records.append({
                **invoice,
                "variance": variance,
                "status": STATUS_NOT_IN_TALLY,
                "match_status": "only_in_tally",
                "review_status": "unreviewed"
            })

            missing_in_tally_records.append({
                "gstin": invoice["gstin"],
                "party_name": invoice["customer_name"],
                "invoice_no": invoice["invoice_no"],
                "invoice_date": invoice["invoice_date"],
                "source_taxable_value": invoice["taxable_value"],
                "source_cgst": invoice["cgst"],
                "source_sgst": invoice["sgst"],
                "source_igst": invoice["igst"],
                "source_total_amount": invoice["total_amount"],
                "taxable_value": invoice["taxable_value"],
                "cgst": invoice["cgst"],
                "sgst": invoice["sgst"],
                "igst": invoice["igst"],
                "total_amount": invoice["total_amount"],
                "match_status": "only_in_tally",
                "review_status": "unreviewed"
            })
            not_present_in_tally += 1

        for voucher in self.tally_data:
            if id(voucher) in matched_tally_ids:
                continue
            variance = voucher["total_amount"]

            total_variance += variance
            records.append({
                **voucher,
                "variance": variance,
                "status": STATUS_NOT_IN_EXCEL,
                "match_status": f"only_in_{self.source_label}",
                "review_status": "unreviewed"
            })

            missing_in_excel_records.append({
                "gstin": voucher["gstin"],
                "party_name": voucher["customer_name"],
                "invoice_no": voucher["invoice_no"],
                "invoice_date": voucher["invoice_date"],
                "tally_taxable_value": voucher["taxable_value"],
                "tally_cgst": voucher["cgst"],
                "tally_sgst": voucher["sgst"],
                "tally_igst": voucher["igst"],
                "tally_total_amount": voucher["total_amount"],
                "taxable_value": voucher["taxable_value"],
                "cgst": voucher["cgst"],
                "sgst": voucher["sgst"],
                "igst": voucher["igst"],
                "total_amount": voucher["total_amount"],
                "match_status": f"only_in_{self.source_label}",
                "review_status": "unreviewed"
            })
            not_present_in_excel += 1

        excel_summary = {
            "total_invoices": len(self.excel_data),
            "total_taxable_value": round(
                sum(x["taxable_value"] for x in self.excel_data), 2
            ),
            "total_cgst": round(
                sum(x["cgst"] for x in self.excel_data), 2
            ),
            "total_sgst": round(
                sum(x["sgst"] for x in self.excel_data), 2
            ),
            "total_igst": round(
                sum(x["igst"] for x in self.excel_data), 2
            ),
            "total_amount": round(
                sum(x["total_amount"] for x in self.excel_data), 2
            )
        }

        tally_summary = {
            "total_invoices": len(self.tally_data),
            "total_taxable_value": round(
                sum(x["taxable_value"] for x in self.tally_data), 2
            ),
            "total_cgst": round(
                sum(x["cgst"] for x in self.tally_data), 2
            ),
            "total_sgst": round(
                sum(x["sgst"] for x in self.tally_data), 2
            ),
            "total_igst": round(
                sum(x["igst"] for x in self.tally_data), 2
            ),
            "total_amount": round(
                sum(x["total_amount"] for x in self.tally_data), 2
            )
        }

        reconciliation_summary = {
            f"total_{self.source_label}_invoices": len(self.excel_data),
            "matched_invoices": matched,
            "partially_matched_invoices": partially_matched_invoices,
            "not_present_in_tally": not_present_in_tally,
            "not_present_in_excel": not_present_in_excel,
            "total_variance": round(total_variance, 2),

            # Review status counts (no DB yet — all unreviewed)
            "reconciled_invoices": 0,
            "pending_invoices": 0,
            "unreviewed_invoices": matched,

            # Financial totals for matched records
            "matched_totals": {
                "taxable_value": round(matched_taxable, 2),
                "cgst": round(matched_cgst, 2),
                "sgst": round(matched_sgst, 2),
                "igst": round(matched_igst, 2),
                "total_amount": round(matched_total, 2)
            },

            # Reconciled totals (no DB yet — always zero)
            "reconciled_totals": {
                "taxable_value": 0,
                "cgst": 0,
                "sgst": 0,
                "igst": 0,
                "total_amount": 0
            }
        }
        return {
            "excel_summary": excel_summary,
            "tally_summary": tally_summary,
            "reconciliation_summary": reconciliation_summary,
            "matched_records": matched_records,
            "partially_matched_records": partially_matched_records,
            "only_in_tally": missing_in_tally_records,
            f"only_in_{self.source_label}": missing_in_excel_records,
            "records": records
        }
