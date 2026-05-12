import express from "express";

import { sendToTally }
from "../services/tallyClient.js";

import pool
from "../db/index.js";

import {
  parseXML
}
from "../services/parser.js";

import {
  getParentGroupsXML
}
from "../services/xmlBuilder.js";

const router =
  express.Router();

/* ===================================================
   PARENT GROUPS
=================================================== */

router.get(
  "/parent-groups",

  async (req, res) => {

    try {

      /* =========================================
         QUERY PARAMS
      ========================================= */

      const company =
        req.query.company;

      /* =========================================
         VALIDATION
      ========================================= */

      if (!company) {

        return res.status(400).json({

          status: "error",

          message:
            "company required"

        });

      }

      /* =========================================
         XML
      ========================================= */

      const xml =
        getParentGroupsXML(
          company
        );

      /* =========================================
         SEND TO TALLY
      ========================================= */

      const responseXML =
        await sendToTally(
          xml
        );

      /* =========================================
         PARSE XML
      ========================================= */

      const parsed =
        parseXML(
          responseXML
        );
        console.log(
  JSON.stringify(
    parsed,
    null,
    2
  )
);

      /* =========================================
         COLLECTION
      ========================================= */
const collection =

  parsed?.ENVELOPE?.BODY
    ?.DATA?.COLLECTION
    ?.GROUP

  ||

  [];

const list =

  Array.isArray(collection)

    ? collection

    : collection

    ? [collection]

    : [];
      /* =========================================
         CLEAN FUNCTION
      ========================================= */

      const clean = (value) => {

        if (
          value === null ||
          value === undefined
        ) {

          return null;

        }

        return String(value)

          .replace(
            /&#13;&#10;|\r|\n/g,
            ""
          )

          .trim();

      };

     
/* =========================================
   ALL GROUP NAMES
========================================= */

const parentGroups =

  [

    ...new Set(

      list

        .map((group) =>

          clean(

            group?.NAME ||

            (

              Array.isArray(

                group?.[
                  "LANGUAGENAME.LIST"
                ]?.[
                  "NAME.LIST"
                ]?.NAME

              )

                ? group?.[
                    "LANGUAGENAME.LIST"
                  ]?.[
                    "NAME.LIST"
                  ]?.NAME?.[0]

                : group?.[
                    "LANGUAGENAME.LIST"
                  ]?.[
                    "NAME.LIST"
                  ]?.NAME

            )

          )

        )

        .filter(Boolean)

    )

  ]

  .sort();

/* =========================================
   DELETE OLD GROUPS
========================================= */

await pool.query(

  `
  DELETE FROM app.parent_groups
  WHERE company_name = $1
  `,

  [company]

);

/* =========================================
   INSERT NEW GROUPS
========================================= */

for (const group of parentGroups) {

  await pool.query(

    `
    INSERT INTO app.parent_groups (

      company_name,
      group_name

    )

    VALUES (

      $1,
      $2

    )
    `,

    [

      company,
      group

    ]

  );

}

/* =========================================
   SUCCESS RESPONSE
========================================= */

return res.status(200).json({

  status: "success",

  source: "tally",

  company,

  total:
    parentGroups.length,

  parent_groups:
    parentGroups

});

    } catch (err) {

      console.log(

        "❌ PARENT GROUP ERROR:",

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