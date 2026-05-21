import express from "express";

import { sendToTally }
from "../services/tallyClient.js";

import {
  createLedgerXML
}
from "../services/pushXmlBuilder.js";

const router = express.Router();

/* =====================================
   PUSH LEDGER API
===================================== */

router.post(

  "/push/ledger",

  async (req, res) => {

    try {

      /* ==============================
         REQUEST BODY
      ============================== */

      const data = req.body;

      /* ==============================
         VALIDATION
      ============================== */

      if (
        !data.company ||
        !data.ledger_name ||
        !data.parent
      ) {

        return res.status(400).json({

          status: "error",

          message:
            "company, ledger_name and parent are required"

        });

      }

      /* ==============================
         XML
      ============================== */

      const xml =
        createLedgerXML(data);

      /* ==============================
         SEND TO TALLY
      ============================== */

      const tallyResponse =
        await sendToTally(xml);

      /* ==============================
         CREATED CHECK
      ============================== */

      const createdMatch =
        tallyResponse.match(
          /<CREATED>(\d+)<\/CREATED>/
        );

      const created =
        createdMatch
          ? Number(createdMatch[1])
          : 0;

      /* ==============================
         ALTERED CHECK
      ============================== */

      const alteredMatch =
        tallyResponse.match(
          /<ALTERED>(\d+)<\/ALTERED>/
        );

      const altered =
        alteredMatch
          ? Number(alteredMatch[1])
          : 0;

      /* ==============================
         LINE ERROR
      ============================== */

      const lineErrorMatch =
        tallyResponse.match(
          /<LINEERROR>(.*?)<\/LINEERROR>/
        );

      const lineError =
        lineErrorMatch
          ? lineErrorMatch[1]
          : null;

      /* ==============================
         FAILURE
      ============================== */

      if (
        created !== 1 &&
        altered !== 1
      ) {

        return res.status(400).json({

          status: "error",

          message:
            lineError ||
            "Ledger creation failed"

        });

      }

      /* ==============================
         SUCCESS
      ============================== */

      return res.status(200).json({

        status: "success",

        message:
          altered === 1

            ? "Ledger already exists and altered successfully"

            : "Ledger pushed successfully",

        company:
          data.company,

        ledger_name:
          data.ledger_name,

        parent:
          data.parent,

        summary: {

          created,

          altered

        }

      });

    } catch (err) {

      console.log(

        "❌ PUSH LEDGER ERROR:",

        err.message

      );

      return res.status(500).json({

        status: "error",

        message:
          err.message

      });

    }

  }

);

export default router;