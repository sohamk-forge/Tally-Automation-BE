    // // src/utils/tally.js
    // import axios from "axios";
    // import { getCompanyGSTDetailsXML } from "../services/xmlBuilder.js";

    // const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";

    // const gstinCache = new Map();
    // const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

    // export const getCompanyGSTIN = async (companyName) => {
    //   const cached = gstinCache.get(companyName);
    //   if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    //     return cached.gstin;
    //   }

    //   const xml = getCompanyGSTDetailsXML(companyName);

    //   const response = await axios.post(TALLY_URL, xml, {
    //     headers: { "Content-Type": "text/xml" },
    //   });

    //   const rawXml = response.data;
    //   const match = /<GSTREGNUMBER>(.*?)<\/GSTREGNUMBER>/i.exec(rawXml);
    //   const gstin = match ? match[1].trim() : null;

    //   if (gstin) {
    //     gstinCache.set(companyName, { gstin, fetchedAt: Date.now() });
    //   }

    //   return gstin;
    // };

    // export const getStateCodeFromGSTIN = (gstin) => {
    //   if (!gstin) return null;
    //   const isValid = /^[0-9]{2}/.test(gstin);
    //   return isValid ? gstin.substring(0, 2) : null;
    // };