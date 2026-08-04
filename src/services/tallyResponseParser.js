/**
 * Shared success/failure classification for a raw Tally XML response.
 * All push modules use the same CREATED/ALTERED/LINEERROR convention
 * (see pushLedger/pushStockItem/pushBank/pushOdBank/pushVoucher/
 * pushInvoice/pushSalesInvoice workers) so this is the one place that
 * decides "did Tally accept this" instead of trusting the Connector's
 * own judgment on it.
 */
export function parseTallyResponse(rawResponse) {

  const response = rawResponse || "";

  const created = Number(
    response.match(/<CREATED>(\d+)<\/CREATED>/)?.[1] || 0
  );

  const altered = Number(
    response.match(/<ALTERED>(\d+)<\/ALTERED>/)?.[1] || 0
  );

  const lineError =
    response.match(/<LINEERROR>(.*?)<\/LINEERROR>/)?.[1]?.trim() || null;

  const isSuccess = created === 1 || altered === 1;

  return {
    isSuccess,
    errorMessage: isSuccess ? null : (lineError || "Tally push failed")
  };
}
