// Same official GST state/UT code list as src/python/sales_generator.py's
// GST_STATE_MAP — kept in sync manually since one is Python and one is JS.
export const GST_STATE_MAP = {
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
  "97": "Other Territory", "99": "Centre Jurisdiction"
};

// Resolves whatever a source gives us (a real state name, or a raw 2-digit
// GST code — some bulk-upload formats send the latter, see the Warranty
// report's ShipToState/BillToState columns) into a real state name.
export function resolveStateName(rawState) {
  const value = String(rawState || "").trim();
  if (!value) return "";
  if (/^\d{1,2}$/.test(value)) {
    return GST_STATE_MAP[value.padStart(2, "0")] || value;
  }
  return value;
}

// Loose equality for comparing two state names that may differ only in
// case/whitespace/punctuation (e.g. "Andhra Pradesh" vs "andhra pradesh ").
export function normalizeStateName(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z]/g, "");
}
