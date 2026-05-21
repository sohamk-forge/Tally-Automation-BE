import express from "express";
import pool from "../db/index.js";

const router = express.Router();

/* =========================================
   GET ALL COMPANIES
========================================= */

router.get("/", async (req, res) => {

  try {

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    const offset = (page - 1) * limit;

    // TOTAL COUNT
    const totalResult = await pool.query(`
      SELECT COUNT(*) FROM app.companies
    `);

    const total = parseInt(totalResult.rows[0].count);

    // FETCH COMPANIES
    const result = await pool.query(
      `
      SELECT
        id,
        name,
        financial_year_start,
        financial_year_end,

        CONCAT(
          financial_year_start,
          '-',
          financial_year_end
        ) AS financial_year

      FROM app.companies

      ORDER BY id DESC

      LIMIT $1 OFFSET $2
      `,
      [limit, offset]
    );

    return res.json({
      status: "success",
      message: "Companies fetched successfully",
      page,
      limit,
      total,
      count: result.rows.length,
      data: result.rows
    });

  } catch (err) {

    console.log("COMPANY ERROR:", err);

    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

/* =========================================
   SYNC COMPANIES FROM TALLY
========================================= */

router.get("/sync", async (req, res) => {

  try {

    // TALLY XML — Collection fetches all companies
    const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CompanyCollection</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CompanyCollection">
            <TYPE>Company</TYPE>
            <FETCH>NAME, BOOKSFROM, ENDINGAT</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

    // SEND XML TO TALLY
    const response = await fetch(
      "http://localhost:9000",
      {
        method: "POST",
        headers: {
          "Content-Type": "text/xml"
        },
        body: xml
      }
    );

    // RAW XML RESPONSE
    const responseXML = await response.text();

    console.log("RAW XML =>");
    console.log(responseXML);

    // CHECK RESPONSE
    if (!responseXML.includes("<ENVELOPE>")) {
      throw new Error("Invalid Tally response");
    }

    // XML PARSER
    const { XMLParser } = await import("fast-xml-parser");

    const parser = new XMLParser({
      ignoreAttributes: false,
      isArray: (name) => name === "COMPANY"  // always treat as array
    });

    // PARSE XML
    const parsed = parser.parse(responseXML);

    console.log(
      "PARSED =>",
      JSON.stringify(parsed, null, 2)
    );

    // GET COLLECTION DATA
    // Tally Collection response: ENVELOPE > BODY > DATA > COLLECTION > COMPANY[]
    const companies =
      parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY ||
      parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.company ||
      [];

    console.log(
      "COMPANIES =>",
      JSON.stringify(companies, null, 2)
    );

    if (!companies.length) {
      throw new Error("No companies received from Tally");
    }

    // UPSERT EACH COMPANY
    const results = [];

    for (const company of companies) {

      const rawName =
  company?.["@_NAME"] ||
  company?.NAME?.["#text"] ||
  company?.NAME ||
  null;

const rawFromDate =
  company?.BOOKSFROM?.["#text"] ||
  company?.BOOKSFROM ||
  null;

const rawToDate =
  company?.ENDINGAT?.["#text"] ||
  company?.ENDINGAT ||
  null;

      console.log("NAME =>", rawName);
      console.log("FROM =>", rawFromDate);
      console.log("TO   =>", rawToDate);

      // VALIDATION
      if (!rawName) {
        console.warn("Skipping entry — company name missing");
        continue;
      }

      // CLEAN VALUES
      // Tally dates come as YYYYMMDD — convert to YYYY-MM-DD
      const name = String(rawName).trim();

     const financial_year_start =
  rawFromDate
    ? parseInt(
        String(rawFromDate).substring(0, 4)
      )
    : null;

const financial_year_end =
  rawToDate
    ? parseInt(
        String(rawToDate).substring(0, 4)
      )
    : null;

      // INSERT / UPDATE DATABASE
      const result = await pool.query(
        `
        INSERT INTO app.companies (

          name,
          financial_year_start,
          financial_year_end,
          created_at,
          updated_at

        )

        VALUES (

          $1,
          $2,
          $3,
          NOW(),
          NOW()

        )

        ON CONFLICT (name)

        DO UPDATE SET

          financial_year_start =
            EXCLUDED.financial_year_start,

          financial_year_end =
            EXCLUDED.financial_year_end,

          updated_at = NOW()

        RETURNING id
        `,
        [
          name,
          financial_year_start,
          financial_year_end
        ]
      );

      results.push({
        id: result.rows[0]?.id,
        name,
        financial_year_start,
        financial_year_end
      });
    }

    // SUCCESS RESPONSE
    return res.json({
      status: "success",
      source: "tally",
      synced: results.length,
      data: results
    });

  } catch (err) {

    console.log("SYNC ERROR:", err);

    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;