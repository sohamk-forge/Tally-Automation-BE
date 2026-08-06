/* ===================================================
    COMPANY DETAILS SYNC (address, email, GSTIN, state)
    Writes into the separate `company_details` table
    (not `companies`) — one row per company_id, upserted
    on every run. Used by the voucher PDF generator.
  =================================================== */

  router.get("/company-details", async (req, res) => {

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      /* =====================================
        GET ALL COMPANIES ALREADY IN DB
        (run /companies first if a company
        hasn't been synced at all yet)
      ===================================== */
      const companiesResult = await client.query(
        `SELECT id, name FROM app_test.companies`
      );

      if (companiesResult.rows.length === 0) {
        throw new Error("No companies found — run /companies sync first");
      }

      let upserted = 0;
      let failed = 0;
      const failures = [];

      for (const { id: companyId, name: companyName } of companiesResult.rows) {

        try {
          const xml = getCompanyDetailsXML(companyName);
          const responseXML = await sendToTallyViaConnector(
            companyId,
            xml,
            "sync",
            req.headers['x-user-id'] || null
          );

          const parsed = await parseXML(responseXML);

          const companyObj =
            parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY ||
            parsed?.ENVELOPE?.BODY?.DATA?.TALLYMESSAGE?.COMPANY ||
            parsed?.ENVELOPE?.BODY?.DATA?.COMPANY;

          if (!companyObj) {
            failed++;
            failures.push({ company: companyName, reason: "No COMPANY object in Tally response" });
            console.log(`❌ COMPANY DETAILS — no COMPANY object for: ${companyName}`);
            continue;
          }

          /* =================================
            ADDRESS — Tally returns repeated
            <ADDRESS> lines; parser may give an
            array (multi-line) or a single string
          ================================= */
          const rawAddress = companyObj?.ADDRESS;
          const address = Array.isArray(rawAddress)
            ? rawAddress.map((a) => clean(a)).filter(Boolean).join(", ")
            : clean(rawAddress);

          const state = clean(companyObj?.STATENAME || companyObj?.STATE);
          const email = clean(companyObj?.EMAIL);

          /* =================================
            GSTIN — company-level field first,
            then generic fallbacks seen across
            different Tally versions
          ================================= */
          const gstin = clean(
            companyObj?.CMPGSTIN ||
            companyObj?.GSTIN ||
            companyObj?.PARTYGSTIN
          );

          /* =================================
            UPSERT into company_details
            (one row per company_id)
          ================================= */
          await client.query(
            `
            INSERT INTO app_test.company_details
              (company_id, company_name, address, state, email, gstin, last_synced_at, created_at, updated_at)
            VALUES
              ($1, $2, $3, $4, $5, $6, NOW(), NOW(), NOW())
            ON CONFLICT (company_id)
            DO UPDATE SET
              company_name   = EXCLUDED.company_name,
              address        = EXCLUDED.address,
              state          = EXCLUDED.state,
              email          = EXCLUDED.email,
              gstin          = EXCLUDED.gstin,
              last_synced_at = NOW(),
              updated_at     = NOW()
            `,
            [companyId, companyName, address, state, email, gstin]
          );

          upserted++;
          console.log(`✅ COMPANY DETAILS UPSERTED: ${companyName}`);

        } catch (err) {
          failed++;
          failures.push({ company: companyName, reason: err.message });
          console.log(`❌ COMPANY DETAILS FAILED: ${companyName} — ${err.message}`);
        }
      }

      await client.query("COMMIT");

      return res.status(200).json({
        status: "success",
        message: "Company details synced successfully",
        summary: {
          total: companiesResult.rows.length,
          upserted,
          failed,
        },
        failures: failures.slice(0, 10),
      });

    } catch (err) {
      await client.query("ROLLBACK");
      console.log("❌ COMPANY DETAILS SYNC ERROR:", err.message);
      return res.status(500).json({
        status: "error",
        message: err.message,
      });
    } finally {
      client.release();
    }
  });