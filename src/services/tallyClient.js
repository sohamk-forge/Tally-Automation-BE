import axios from "axios";
import { TALLY_URL } from "../config/env.js";

export async function sendToTally(xml) {
  try {
    const res = await axios.post(
      TALLY_URL,
      xml.trim(),
      {
        headers: {
          "Content-Type": "text/xml; charset=utf-8"
        },
        timeout: 60000
      }
    );

    return res.data;

  } catch (err) {
    console.error("Tally Error:", err);

    throw new Error(
      err.response?.data ||
      err.message ||
      "Tally request failed"
    );
  }
}