import axios from "axios";
import { TALLY_URL } from "../config/env.js";

export async function sendToTally(xml) {
  try {
    const res = await axios.post(
      TALLY_URL,
      xml.trim(), // 🔥 ensure clean XML
      {
        headers: {
          "Content-Type": "text/xml",
          "Connection": "close",   // 🔥 prevents CLOSE_WAIT issue
        },
        timeout: 120000,            // 🔥 15 sec max wait
        validateStatus: () => true // 🔥 prevent axios crash on non-200
      }
    );

    // 🔥 check response manually
    if (!res.data) {
      throw new Error("Empty response from Tally");
    }

    return res.data;

  } catch (err) {
    console.log("❌ Tally Error:", err.message);

    // 🔥 better error message
    if (err.code === "ECONNREFUSED") {
      throw new Error("Tally not running on port 9000");
    }

    if (err.code === "ECONNABORTED") {
      throw new Error("Tally timeout (slow response)");
    }

    throw new Error(err.message || "Tally request failed");
  }
}