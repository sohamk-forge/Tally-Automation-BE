import express from "express";

import axios from "axios";

import pool from "../db/index.js";

const router =
  express.Router();

/* =========================================
   PUSH OD / OCC BANK LEDGER
========================================= */

router.post(

  "/push-od-bank",

  async (req, res) => {

    try {

      /* =====================================
         REQUEST BODY
      ===================================== */

      const data =
        req.body;

      /* =====================================
         REQUIRED VALIDATION
      ===================================== */

      if (
        !data.company ||
        !data.ledger_name ||
        !data.account_type
      ) {

        return res.status(400).json({

          status: "error",

          message:
            "company, ledger_name and account_type required"

        });

      }

      /* =====================================
         PARENT GROUP
      ===================================== */

      const parentGroup =
        "Bank OD A/c";

      /* =====================================
         XML
      ===================================== */

      const xml = `

<ENVELOPE>

  <HEADER>

    <TALLYREQUEST>
      Import Data
    </TALLYREQUEST>

  </HEADER>

  <BODY>

    <IMPORTDATA>

      <REQUESTDESC>

        <REPORTNAME>
          All Masters
        </REPORTNAME>

        <STATICVARIABLES>

          <SVCURRENTCOMPANY>
            ${data.company}
          </SVCURRENTCOMPANY>

        </STATICVARIABLES>

      </REQUESTDESC>

      <REQUESTDATA>

        <TALLYMESSAGE xmlns:UDF="TallyUDF">

          <LEDGER
            NAME="${data.ledger_name}"
            ACTION="Create"
          >

            <NAME>
              ${data.ledger_name}
            </NAME>

            <MAILINGNAME>
              ${data.ledger_name}
            </MAILINGNAME>

            <PARENT>
              ${parentGroup}
            </PARENT>

            <ISODACCOUNT>
              Yes
            </ISODACCOUNT>

            <ISLOANACCOUNT>
              Yes
            </ISLOANACCOUNT>

            <OPENINGBALANCE>
              ${data.opening_balance || 0}
            </OPENINGBALANCE>

            <ODLIMIT>
              ${data.od_limit || 0}
            </ODLIMIT>

            <SETODLIMIT>
              ${data.od_limit || 0}
            </SETODLIMIT>

            <BANKNAME>
              ${data.bank_name || ""}
            </BANKNAME>

            <BANKBRANCHNAME>
              ${data.branch_name || ""}
            </BANKBRANCHNAME>

            <LEDMAILINGDETAILS.LIST>

              <ADDRESS.LIST TYPE="String">

                <ADDRESS>
                  ${data.address || ""}
                </ADDRESS>

              </ADDRESS.LIST>

              <STATE>
                ${data.state || ""}
              </STATE>

              <COUNTRY>
                ${data.country || ""}
              </COUNTRY>

              <PINCODE>
                ${data.pincode || ""}
              </PINCODE>

              <MOBILE>
                ${data.mobile || ""}
              </MOBILE>

              <EMAIL>
                ${data.email || ""}
              </EMAIL>

            </LEDMAILINGDETAILS.LIST>

            <BANKALLOCATIONS.LIST>

              <BANKACCHOLDERNAME>
                ${data.account_holder || ""}
              </BANKACCHOLDERNAME>

              <BANKDETAILS>
                ${data.account_number || ""}
              </BANKDETAILS>

              <BANKNAME>
                ${data.bank_name || ""}
              </BANKNAME>

              <BANKBRANCHNAME>
                ${data.branch_name || ""}
              </BANKBRANCHNAME>

              <BANKIFSC>
                ${data.ifsc_code || ""}
              </BANKIFSC>

              <SWIFTCODE>
                ${data.swift_code || ""}
              </SWIFTCODE>

            </BANKALLOCATIONS.LIST>

          </LEDGER>

        </TALLYMESSAGE>

      </REQUESTDATA>

    </IMPORTDATA>

  </BODY>

</ENVELOPE>

`;

      /* =====================================
         SEND TO TALLY
      ===================================== */

      const tallyResponse =
        await axios.post(

          "http://localhost:9000",

          xml,

          {
            headers: {
              "Content-Type":
                "text/xml"
            }
          }

        );

      /* =====================================
         STORE IN DB
      ===================================== */

      await pool.query(

        `
        INSERT INTO
        app.bank_od_accounts
        (

          company_name,
          ledger_name,
          account_type,
          opening_balance,
          od_limit,
          bank_name,
          branch_name,
          account_holder,
          account_number,
          ifsc_code,
          swift_code,
          address,
          state,
          country,
          pincode,
          contact_person,
          mobile,
          email

        )

        VALUES
        (

          $1,$2,$3,$4,$5,
          $6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,
          $16,$17,$18

        )
        `,

        [

          data.company,
          data.ledger_name,
          data.account_type,
          data.opening_balance,
          data.od_limit,
          data.bank_name,
          data.branch_name,
          data.account_holder,
          data.account_number,
          data.ifsc_code,
          data.swift_code,
          data.address,
          data.state,
          data.country,
          data.pincode,
          data.contact_person,
          data.mobile,
          data.email

        ]

      );

      /* =====================================
         SUCCESS
      ===================================== */

      return res.status(200).json({

        status: "success",

        message:
          "OD/OCC Ledger pushed successfully",

        tallyResponse:
          tallyResponse.data

      });

    } catch (err) {

      console.log(err.message);

      return res.status(500).json({

        status: "error",

        message:
          err.message

      });

    }

  }

);

export default router;