// =========================================
// src/services/voucherParse.service.js
//
// Parses a Tally voucher export one voucher at a time.
//
// Why: Tally occasionally writes a corrupt voucher into its XML (a custom-field tag with garbled text, e.g.
// <UDF:_UDF_78530824> where the real tag name should be). fast-xml-parser does not complain: it nests every
// following voucher inside the broken one and the sync silently saved only the vouchers before it
// (230 of 422 and 239 of 1160 in one real month, with the step reported as a success).
//
// Each voucher is checked on its own with a strict XML validator and parsed on its own, so one corrupt voucher
// is reported (by number, guid and reason) and every other voucher is still read. The parsed objects are
// the same ones a whole-document parse gives for a clean voucher.
// =========================================

import { XMLValidator } from "fast-xml-parser";
import { parseXMLKeepText } from "./parser.js";

const WRAP_OPEN = "<ENVELOPE><BODY><DATA><COLLECTION>";
const WRAP_CLOSE = "</COLLECTION></DATA></BODY></ENVELOPE>";

const pick = (block, re) => (block.match(re) || [])[1] || null;

// Header fields every voucher has exactly once.
const IDENTITY_FIELDS = ["DATE", "GUID", "VOUCHERNUMBER", "VOUCHERTYPENAME"];

/**
 * @param xml       Tally's response text
 * @param textTags  tags that keep their exact text (same meaning as parseXMLKeepText)
 * @returns { vouchers: object[], corrupt: { index, number, guid, reason }[], rawCount }
 *          vouchers are in Tally's order; rawCount = how many <VOUCHER ...> elements the XML contains.
 * @throws  when the response is cut off, or when the vouchers found do not add up to rawCount.
 */
export function parseVouchersIsolated(xml, textTags = []) {
  const text = String(xml ?? "");

  const starts = [...text.matchAll(/<VOUCHER\s/g)].map((m) => m.index);
  if (starts.length === 0) {
    // No vouchers in the response: keep the original behaviour (parse errors still surface).
    parseXMLKeepText(text, textTags);
    return { vouchers: [], corrupt: [], rawCount: 0 };
  }

  if (!/<\/ENVELOPE>\s*$/.test(text)) {
    throw new Error("Tally's voucher response is incomplete (it does not end with </ENVELOPE>)");
  }

  const vouchers = [];
  const corrupt = [];

  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : text.indexOf("</COLLECTION>", from);
    const segment = text.slice(from, to < 0 ? text.length : to);
    const close = segment.lastIndexOf("</VOUCHER>");
    const block = close >= 0 ? segment.slice(0, close + "</VOUCHER>".length) : segment;

    // guids / dates: every GUID and yyyymmdd date found inside the block, even a damaged one. They let the
    // sync ask Tally again for just that day (recoverCorruptVouchers) and keep an already-saved voucher
    // from being treated as deleted in Tally.
    const describe = (reason) => ({
      index: i + 1,
      number: pick(block, /<VOUCHERNUMBER[^>]*>([^<]*)</),
      guid: pick(block, /<GUID>([^<]*)</),
      guids: [...new Set([...block.matchAll(/<GUID>([^<]*)</g)].map((m) => m[1]))],
      dates: [...new Set([...block.matchAll(/<DATE[^>]*>(\d{8})</g)].map((m) => m[1]))],
      reason
    });

    if (close < 0) {
      corrupt.push(describe("voucher has no closing tag"));
      continue;
    }

    const check = XMLValidator.validate(block);
    if (check !== true) {
      const err = check.err || {};
      corrupt.push(describe(`${err.msg || "invalid XML"}${err.line ? ` (line ${err.line})` : ""}`));
      continue;
    }

    let parsed;
    try {
      parsed = parseXMLKeepText(WRAP_OPEN + block + WRAP_CLOSE, textTags);
    } catch (err) {
      corrupt.push(describe(err.message));
      continue;
    }

    const voucher = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.VOUCHER;
    if (!voucher || Array.isArray(voucher)) {
      corrupt.push(describe("could not be read as a single voucher"));
      continue;
    }

    // Two vouchers fused into one block: Tally overwrote the end of one voucher and the start of the next with a
    // text fragment, so the block is still valid XML but holds two of each header field (two dates, two numbers).
    const fused = IDENTITY_FIELDS.find((field) => Array.isArray(voucher[field]));
    if (fused) {
      corrupt.push({
        ...describe(`two vouchers fused by corrupt XML (${fused} appears ${voucher[fused].length} times)`),
        number: [].concat(voucher.VOUCHERNUMBER ?? []).join(" and ") || pick(block, /<VOUCHERNUMBER[^>]*>([^<]*)</),
        guid: [].concat(voucher.GUID ?? []).join(" and ") || pick(block, /<GUID>([^<]*)</)
      });
      continue;
    }
    vouchers.push(voucher);
  }

  if (vouchers.length + corrupt.length !== starts.length) {
    throw new Error(
      `Voucher count mismatch: the XML has ${starts.length} vouchers but ${vouchers.length} were read and ${corrupt.length} reported corrupt`
    );
  }

  return { vouchers, corrupt, rawCount: starts.length };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tally's corruption is a random glitch in big exports, so a vouchers that came back corrupt often comes back
 * clean when Tally is asked for just that one day. For each day that has a corrupt voucher, fetch that day alone
 * (one small request at a time, with a pause) and keep the vouchers that were missing from the first response.
 *
 * Never throws: a failed retry just leaves those vouchers reported as corrupt.
 *
 * @param vouchers   the vouchers already read from the main response
 * @param corrupt    corrupt entries from parseVouchersIsolated (with guids / dates)
 * @param fetchDay   async (yyyymmdd) => Tally's XML for that single day
 * @returns { recovered: object[], stillCorrupt: object[], days: string[] }
 */
export async function recoverCorruptVouchers({ vouchers, corrupt, fetchDay, textTags = [], maxDays = 6, pauseMs = 3000, log = () => {} }) {
  const days = [...new Set(corrupt.flatMap((c) => c.dates || []))].sort().slice(0, maxDays);
  const have = new Set(vouchers.map((v) => String(v.GUID)));
  const recovered = [];

  for (const [i, day] of days.entries()) {
    if (i > 0 && pauseMs > 0) await sleep(pauseMs);
    try {
      const retry = parseVouchersIsolated(await fetchDay(day), textTags);
      let added = 0;
      for (const voucher of retry.vouchers) {
        const guid = String(voucher.GUID);
        if (!have.has(guid)) { have.add(guid); recovered.push(voucher); added++; }
      }
      log(`retry of ${day}: ${retry.vouchers.length} vouchers read, ${added} newly recovered, ${retry.corrupt.length} still corrupt`);
    } catch (err) {
      log(`retry of ${day} failed: ${err.message}`);
    }
  }

  const got = new Set(recovered.map((v) => String(v.GUID)));
  // A corrupt entry is recovered when every voucher it contained (a fused entry holds two) came back clean.
  const stillCorrupt = corrupt.filter((c) => !(c.guids?.length && c.guids.every((g) => got.has(g))));
  return { recovered, stillCorrupt, days };
}
