import axios from "axios";
import fs from "fs";
import { TALLY_URL } from "../config/env.js";

export async function sendToTally(xml) {
  try {

  console.log("=================================");
console.log("📤 FULL XML SENT TO TALLY");
console.log("=================================");
console.log(xml);
console.log("=================================");

fs.writeFileSync("lastVoucher.xml", xml);
console.log("XML SAVED");

    const res = await axios.post(
  TALLY_URL,
  { xml },
  {
    headers: {
      "Content-Type": "application/json"
    },
    timeout: 120000,
    validateStatus: () => true
  }
);

    console.log("=================================");
    console.log("📥 RAW XML RESPONSE");
    console.log("=================================");
    console.log(res.data);
    console.log("=================================");

    if (!res.data) {
      throw new Error("Empty response from Tally");
    }

    return res.data;

  } catch (err) {

    console.log("=================================");
    console.log("❌ TALLY ERROR");
    console.log("=================================");
    console.log(err);
    console.log("=================================");

    if (err.code === "ECONNREFUSED") {
      throw new Error("Tally not running on port 9000");
    }

    if (err.code === "ECONNABORTED") {
      throw new Error("Tally timeout");
    }

    throw new Error(err.message || "Tally request failed");
  }
}