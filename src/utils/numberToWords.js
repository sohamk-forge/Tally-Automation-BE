const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = [
  '', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety',
];

function twoDigits(n) {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
}

function threeDigits(n) {
  const hundred = Math.floor(n / 100);
  const rest = n % 100;
  let out = '';
  if (hundred) out += ONES[hundred] + ' Hundred';
  if (rest) out += (out ? ' ' : '') + twoDigits(rest);
  return out;
}

// Indian numbering: ... Crore, Lakh, Thousand, Hundred
function integerToWords(num) {
  if (num === 0) return 'Zero';

  const crore = Math.floor(num / 10000000);
  num %= 10000000;
  const lakh = Math.floor(num / 100000);
  num %= 100000;
  const thousand = Math.floor(num / 1000);
  num %= 1000;
  const hundred = num;

  const parts = [];
  if (crore) parts.push(threeDigits(crore) + ' Crore');
  if (lakh) parts.push(threeDigits(lakh) + ' Lakh');
  if (thousand) parts.push(threeDigits(thousand) + ' Thousand');
  if (hundred) parts.push(threeDigits(hundred));

  return parts.join(' ');
}

/**
 * Converts an amount (number or numeric string, e.g. 10082.59) into the
 * "Indian Rupee <words> Only" / "Indian Rupee <words> and <paise> paise Only"
 * format used on the vouchers.
 */
function amountToWords(amount) {
  const value = Math.round(Number(String(amount).replace(/,/g, '')) * 100) / 100;
  const rupees = Math.floor(value);
  const paise = Math.round((value - rupees) * 100);

  const rupeeWords = integerToWords(rupees);

  if (paise > 0) {
    const paiseWords = integerToWords(paise);
    return `Indian Rupee ${rupeeWords} and ${paiseWords} paise Only`;
  }
  return `Indian Rupee ${rupeeWords} Only`;
}

export { amountToWords, integerToWords };
