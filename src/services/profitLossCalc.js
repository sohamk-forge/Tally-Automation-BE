import { parseTallyAmount } from "../utils/tallyAmount.js";

/**
 * Profit & loss figures from Tally's group collection (Sales, Purchase, Direct/Indirect
 * Expenses and Incomes, Stock-in-Hand). Pure: no I/O, so the dashboard numbers can be unit-tested.
 *
 * Amounts are Tally-signed (negative = Dr). Each group is read on its NORMAL side — incomes are
 * Cr, expenses/purchases/stock are Dr — so a group on the unusual side reduces the total.
 *
 * Gross profit = sales + direct incomes + closing stock - opening stock - purchases - direct expenses
 * (Tally's own formula; leaving stock out made the dashboard margin wrong).
 */
export function computeProfitLoss(groups) {
  const list = Array.isArray(groups) ? groups : groups ? [groups] : [];

  let totalSales = 0, totalPurchase = 0, directExpenses = 0, directIncomes = 0;
  let stockValue = 0, openingStock = 0, indirectIncome = 0, indirectExpenses = 0;

  for (const group of list) {
    const rawName =
      group?.["LANGUAGENAME.LIST"]?.[0]?.["NAME.LIST"]?.[0]?.NAME ||
      group?.["LANGUAGENAME.LIST"]?.["NAME.LIST"]?.NAME ||
      group?.NAME;

    let names = [];
    if (Array.isArray(rawName)) names = rawName;
    else if (rawName) names = [rawName];

    const signed = parseTallyAmount(group?.CLOSINGBALANCE);
    const asCredit = signed; // income groups: Cr is positive
    const asDebit = -signed; // expense / purchase / asset groups: Dr is positive

    if (names.some((n) => n === "Sales Accounts" || n?.includes("Sales"))) totalSales = asCredit;
    else if (names.some((n) => n === "Purchase Accounts" || n?.includes("Purchase"))) totalPurchase = asDebit;
    else if (names.some((n) => n === "Direct Expenses" || n?.includes("Direct Expenses"))) directExpenses = asDebit;
    else if (names.some((n) => n === "Direct Incomes" || n?.includes("Direct Incomes"))) directIncomes = asCredit;
    // Tally names the group "Stock-in-Hand"; compare ignoring case, hyphens and spaces.
    else if (names.some((n) => String(n || "").toLowerCase().replace(/[\s-]/g, "") === "stockinhand")) {
      stockValue = asDebit; // closing stock
      openingStock = -parseTallyAmount(group?.OPENINGBALANCE); // opening stock (Dr positive)
    } else if (names.some((n) => n === "Indirect Incomes" || n?.includes("Indirect Income"))) indirectIncome = asCredit;
    else if (names.some((n) => n === "Indirect Expenses" || n?.includes("Indirect Expense"))) indirectExpenses = asDebit;
  }

  const grossProfit = Number(
    (totalSales + directIncomes + stockValue - openingStock - totalPurchase - directExpenses).toFixed(2)
  );
  const netProfit = Number((grossProfit + indirectIncome - indirectExpenses).toFixed(2));
  const profitMargin = totalSales > 0 ? Number(((netProfit / totalSales) * 100).toFixed(2)) : 0;
  const grossProfitPercent = totalSales > 0 ? Number(((grossProfit / totalSales) * 100).toFixed(2)) : 0;

  return {
    totalSales, totalPurchase, directExpenses, directIncomes, stockValue, openingStock,
    indirectIncome, indirectExpenses, grossProfit, netProfit, profitMargin, grossProfitPercent
  };
}
