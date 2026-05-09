export const getCompaniesXML = () => {

  return `
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

        <SVEXPORTFORMAT>
          $$SysName:XML
        </SVEXPORTFORMAT>

      </STATICVARIABLES>

      <TDL>

        <TDLMESSAGE>

          <COLLECTION NAME="CompanyCollection">

            <TYPE>Company</TYPE>

            <FETCH>
              NAME,
              BOOKSFROM,
              ENDINGAT
            </FETCH>

          </COLLECTION>

        </TDLMESSAGE>

      </TDL>

    </DESC>

  </BODY>

</ENVELOPE>
`;

};

/* =========================================
   LEDGER XML
========================================= */

export const getLedgersXML = (company) => {

  return `
<ENVELOPE>

  <HEADER>

    <VERSION>1</VERSION>

    <TALLYREQUEST>Export</TALLYREQUEST>

    <TYPE>Collection</TYPE>

    <ID>List of Ledgers</ID>

  </HEADER>

  <BODY>

    <DESC>

      <STATICVARIABLES>

        <SVCURRENTCOMPANY>
          ${company}
        </SVCURRENTCOMPANY>

        <SVEXPORTFORMAT>
          $$SysName:XML
        </SVEXPORTFORMAT>

      </STATICVARIABLES>

      <TDL>

        <TDLMESSAGE>

          <COLLECTION NAME="List of Ledgers">

            <TYPE>Ledger</TYPE>

            <FETCH>NAME</FETCH>

          </COLLECTION>

        </TDLMESSAGE>

      </TDL>

    </DESC>

  </BODY>

</ENVELOPE>
`;

};



/* ==================================================
   FULL LEDGER DETAILS XML
================================================== */

export const getLedgerDetailsXML = (
  company,
  ledgerName
) => {

  return `
<ENVELOPE>

  <HEADER>

    <VERSION>1</VERSION>

    <TALLYREQUEST>Export</TALLYREQUEST>

    <TYPE>Object</TYPE>

    <SUBTYPE>Ledger</SUBTYPE>

    <ID TYPE="Name">
      ${ledgerName}
    </ID>

  </HEADER>

  <BODY>

    <DESC>

      <STATICVARIABLES>

        <SVCURRENTCOMPANY>
          ${company}
        </SVCURRENTCOMPANY>

        <SVEXPORTFORMAT>
          $$SysName:XML
        </SVEXPORTFORMAT>

      </STATICVARIABLES>

      <FETCHLIST>

        <FETCH>NAME</FETCH>

        <FETCH>PARENT</FETCH>

        <FETCH>ADDRESS</FETCH>

        <FETCH>MAILINGNAME</FETCH>

        <FETCH>STATENAME</FETCH>

<FETCH>STATE</FETCH>

<FETCH>LEDSTATENAME</FETCH>

        <FETCH>COUNTRYNAME</FETCH>

        <FETCH>PINCODE</FETCH>

       <FETCH>PHONE</FETCH>

<FETCH>MOBILE</FETCH>

<FETCH>EMAIL</FETCH>

<FETCH>LEDGERPHONE</FETCH>

<FETCH>LEDGERMOBILE</FETCH>

<FETCH>LEDGEREMAIL</FETCH>

        <FETCH>CONTACTPERSON</FETCH>

        <FETCH>PARTYGSTIN</FETCH>

        <FETCH>GSTREGISTRATIONTYPE</FETCH>

        <FETCH>INCOMETAXNUMBER</FETCH>

        <FETCH>OPENINGBALANCE</FETCH>

        <FETCH>CLOSINGBALANCE</FETCH>

        <FETCH>CREDITPERIOD</FETCH>

        <FETCH>ISBILLWISEON</FETCH>

        <FETCH>ISREVENUE</FETCH>

        <FETCH>ISDEEMEDPOSITIVE</FETCH>

      </FETCHLIST>

    </DESC>

  </BODY>

</ENVELOPE>
`;

};