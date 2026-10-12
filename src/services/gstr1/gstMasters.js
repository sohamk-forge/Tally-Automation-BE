// src/services/gstr1/gstMasters.js
//
// Small GST lookup tables used by the GSTR-1 builder: GSTIN validation,
// state name -> GST state code, Tally unit -> GST UQC.

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Format + check-digit validation (GSTN mod-36 algorithm). */
export function isValidGstin(value) {
  const g = String(value || "").trim().toUpperCase();
  if (!GSTIN_RE.test(g)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(g[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36] === g[14];
}

const STATES = {
  "01": ["jammu and kashmir", "jammu kashmir"],
  "02": ["himachal pradesh"],
  "03": ["punjab"],
  "04": ["chandigarh"],
  "05": ["uttarakhand", "uttaranchal"],
  "06": ["haryana"],
  "07": ["delhi", "new delhi"],
  "08": ["rajasthan"],
  "09": ["uttar pradesh"],
  "10": ["bihar"],
  "11": ["sikkim"],
  "12": ["arunachal pradesh"],
  "13": ["nagaland"],
  "14": ["manipur"],
  "15": ["mizoram"],
  "16": ["tripura"],
  "17": ["meghalaya"],
  "18": ["assam"],
  "19": ["west bengal"],
  "20": ["jharkhand"],
  "21": ["odisha", "orissa"],
  "22": ["chhattisgarh", "chattisgarh"],
  "23": ["madhya pradesh"],
  "24": ["gujarat"],
  "26": ["dadra and nagar haveli and daman and diu", "dadra and nagar haveli", "daman and diu"],
  "27": ["maharashtra"],
  "29": ["karnataka"],
  "30": ["goa"],
  "31": ["lakshadweep"],
  "32": ["kerala"],
  "33": ["tamil nadu"],
  "34": ["puducherry", "pondicherry"],
  "35": ["andaman and nicobar islands", "andaman and nicobar"],
  "36": ["telangana"],
  "37": ["andhra pradesh"],
  "38": ["ladakh"],
  "97": ["other territory"],
};

const normState = (s) => String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z]+/g, " ").trim();
const STATE_BY_NAME = new Map(Object.entries(STATES).flatMap(([code, names]) => names.map((n) => [normState(n), code])));

/** "Maharashtra" -> "27"; null when unknown. */
export function stateCodeFromName(name) {
  return STATE_BY_NAME.get(normState(name)) || null;
}

const UQC_BY_UNIT = {
  NOS: ["nos", "no", "number", "numbers", "nums"],
  PCS: ["pcs", "pc", "piece", "pieces"],
  UNT: ["unit", "units", "u"],
  SET: ["set", "sets"],
  PRS: ["pair", "pairs", "prs"],
  DOZ: ["dozen", "doz", "dzn"],
  BOX: ["box", "boxes"],
  PAC: ["pkt", "packet", "packets", "pack", "pac"],
  BAG: ["bag", "bags"],
  BTL: ["btl", "bottle", "bottles"],
  BDL: ["bundle", "bundles", "bdl"],
  CAN: ["can", "cans"],
  CTN: ["ctn", "carton", "cartons"],
  ROL: ["roll", "rolls", "rol"],
  KGS: ["kg", "kgs", "kilogram", "kilograms", "kilo"],
  GMS: ["g", "gm", "gms", "gram", "grams", "gr"],
  QTL: ["qtl", "quintal", "quintals"],
  MTS: ["mt", "metric ton", "metric tonne", "tonne", "tonnes"],
  TON: ["ton", "tons"],
  MTR: ["m", "mtr", "mtrs", "meter", "meters", "metre", "metres"],
  CMS: ["cm", "cms", "centimeter", "centimetre"],
  KME: ["km", "kms", "kilometer", "kilometre"],
  SQM: ["sqm", "sq m", "sq mtr", "sq mtrs", "square meter", "square metre"],
  SQF: ["sqft", "sq ft", "sq feet", "square feet"],
  LTR: ["l", "ltr", "ltrs", "litre", "litres", "liter", "liters"],
  MLT: ["ml", "mltr", "millilitre", "milliliter"],
  CBM: ["cbm", "cubic meter", "cubic metre"],
};
const UQC_LOOKUP = new Map(Object.entries(UQC_BY_UNIT).flatMap(([uqc, units]) => units.map((u) => [u, uqc])));

/** Tally unit ("nos", "Mtr.", "KGS") -> GST UQC ("NOS", "MTR", "KGS"); "OTH" when unknown. */
export function uqcFromUnit(unit) {
  const u = String(unit || "").toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  if (!u) return "OTH";
  if (UQC_LOOKUP.has(u)) return UQC_LOOKUP.get(u);
  if (/^[a-z]{3}$/i.test(u) && Object.prototype.hasOwnProperty.call(UQC_BY_UNIT, u.toUpperCase())) return u.toUpperCase();
  return "OTH";
}

/** GST rate slabs a line's rate can be inferred to. */
export const GST_SLABS = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];
