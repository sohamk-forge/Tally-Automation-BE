import axios from "axios";
import { TALLY_URL } from "../config/env.js";

export async function sendToTally(xml) {
  const res = await axios.post(TALLY_URL, xml.trim(), {
    headers: {
      "Content-Type": "text/xml; charset=utf-8"
    },
    timeout: 15000
  });

  return res.data;
}