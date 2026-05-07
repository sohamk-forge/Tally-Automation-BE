import axios from "axios";
import { TALLY_URL } from "../config/env.js";

export async function sendToTally(xml) {
  try {

    // ✅ PRINT XML SENT
    console.log("📤 XML SENT TO TALLY:");
    console.log(xml);

    const res = await axios.post(
      TALLY_URL,
      xml.trim(),
      {
        headers: {
          "Content-Type": "text/xml",
          "Connection": "close",
        },
        timeout: 120000,
        validateStatus: () => true
      }
    );

    // ✅ PRINT RAW RESPONSE
    console.log("📥 RAW XML RESPONSE:");
    console.log(res.data);

    if (!res.data) {
      throw new Error("Empty response from Tally");
    }

    return res.data;

  } catch (err) {

    console.log("❌ Tally Error:", err.message);

    if (err.code === "ECONNREFUSED") {
      throw new Error("Tally not running on port 9000");
    }

    if (err.code === "ECONNABORTED") {
      throw new Error("Tally timeout (slow response)");
    }

    throw new Error(err.message || "Tally request failed");
  }
}