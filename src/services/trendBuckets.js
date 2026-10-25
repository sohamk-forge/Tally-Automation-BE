// Sales / purchase trend buckets for the dashboard chart.
//
// Each row is one voucher with the amounts that hit the Sales Accounts and Purchase Accounts
// groups (ex-GST, credit/debit notes netted) — the same basis as the P&L, so the chart adds up to
// the Total sales / Total purchase tiles.

export function getBucketKey(dateObj, period) {
  const d = dateObj;

  if (period === "day") return d.toISOString().split("T")[0];

  if (period === "month") {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  }

  if (period === "year") {
    return `${d.getFullYear()}-01-01`;
  }

  if (period === "week") {
    const day = d.getDay() || 7;
    const monday = new Date(d);
    monday.setDate(d.getDate() - day + 1);
    return monday.toISOString().split("T")[0];
  }

  return d.toISOString().split("T")[0];
}

/** @param {Array<{voucher_date: any, sales_amount?: any, purchase_amount?: any}>} vouchers */
export function bucketVouchers(vouchers, period) {
  const buckets = {};

  for (const v of vouchers) {
    const d = new Date(v.voucher_date);
    if (isNaN(d.getTime())) continue;

    const sales = Number(v.sales_amount) || 0;
    const purchase = Number(v.purchase_amount) || 0;
    if (!sales && !purchase) continue;

    const key = getBucketKey(d, period);

    if (!buckets[key]) {
      buckets[key] = { period_start: key, sales_total: 0, purchase_total: 0 };
    }

    buckets[key].sales_total += sales;
    buckets[key].purchase_total += purchase;
  }

  return Object.values(buckets)
    .map((b) => ({
      ...b,
      sales_total: Number(b.sales_total.toFixed(2)),
      purchase_total: Number(b.purchase_total.toFixed(2)),
      net: Number((b.sales_total - b.purchase_total).toFixed(2))
    }))
    .sort((a, b) => new Date(a.period_start) - new Date(b.period_start));
}
