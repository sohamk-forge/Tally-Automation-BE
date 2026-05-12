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


  export const getGroupSummaryCRXML = (
    company
  ) => {

    return `
  <ENVELOPE>

    <HEADER>

      <VERSION>1</VERSION>

      <TALLYREQUEST>Export</TALLYREQUEST>

      <TYPE>Collection</TYPE>

      <ID>GroupSummaryCR</ID>

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

            <COLLECTION NAME="GroupSummaryCR">

              <TYPE>Ledger</TYPE>

              <CHILDOF>
                Sundry Creditors
              </CHILDOF>

              <FETCH>

                NAME,

                ALIAS,

                PARENT,

                ADDRESS,

                MAILINGNAME,

                STATENAME,

                STATE,

                LEDSTATENAME,

                COUNTRYNAME,

                LEDCOUNTRYNAME,

                PINCODE,

                PHONE,

                LEDGERPHONE,

                MOBILE,

                LEDGERMOBILE,

                FAX,

                EMAIL,

                LEDGEREMAIL,

                CONTACTPERSON,

                PARTYGSTIN,

                GSTREGISTRATIONTYPE,

                INCOMETAXNUMBER,

                OPENINGBALANCE,

                CLOSINGBALANCE

              </FETCH>

            </COLLECTION>

          </TDLMESSAGE>

        </TDL>

      </DESC>

    </BODY>

  </ENVELOPE>
  `;

  };


  export const getGroupSummaryDRXML = (
    company
  ) => {

    return `
  <ENVELOPE>

    <HEADER>

      <VERSION>1</VERSION>

      <TALLYREQUEST>Export</TALLYREQUEST>

      <TYPE>Collection</TYPE>

      <ID>GroupSummaryDR</ID>

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

            <COLLECTION NAME="GroupSummaryDR">

              <TYPE>Ledger</TYPE>

              <CHILDOF>
                Sundry Debtors
              </CHILDOF>

              <FETCH>

                NAME,

                ALIAS,

                PARENT,

                ADDRESS,

                MAILINGNAME,

                STATENAME,

                STATE,

                LEDSTATENAME,

                COUNTRYNAME,

                LEDCOUNTRYNAME,

                PINCODE,

                PHONE,

                LEDGERPHONE,

                MOBILE,

                LEDGERMOBILE,

                FAX,

                EMAIL,

                LEDGEREMAIL,

                CONTACTPERSON,

                PARTYGSTIN,

                GSTREGISTRATIONTYPE,

                INCOMETAXNUMBER,

                OPENINGBALANCE,

                CLOSINGBALANCE

              </FETCH>

            </COLLECTION>

          </TDLMESSAGE>

        </TDL>

      </DESC>

    </BODY>

  </ENVELOPE>
  `;

  };

  export const getGroupSummaryBankXML = (
    company
  ) => {

    return `
  <ENVELOPE>
    <HEADER>
      <VERSION>1</VERSION>
      <TALLYREQUEST>Export</TALLYREQUEST>
      <TYPE>Collection</TYPE>
      <ID>GroupSummaryBank</ID>
    </HEADER>
    <BODY>
    <DESC>
  <STATICVARIABLES>
  <SVCURRENTCOMPANY>
    ${company}
  </SVCURRENTCOMPANY>
          <SVEXPORTFORMAT> $$SysName:XML </SVEXPORTFORMAT>
        </STATICVARIABLES>
        <TDL>
          <TDLMESSAGE>
            <SYSTEM TYPE="Formulae" NAME="BankFilter"> $Parent = "Bank Accounts" </SYSTEM>
            <COLLECTION NAME="GroupSummaryBank">
              <TYPE>Ledger</TYPE>
              <FILTERS> BankFilter </FILTERS>
        <FETCH>NAME,PARENT,MAILINGNAME,ADDRESS,STATENAME,LEDSTATENAME,STATE,COUNTRYNAME,PINCODE,GSTIN,PARTYGSTIN,GSTREGISTRATIONTYPE,ISGSTAPPLICABLE,LEDGERGSTREGDETAILS.LIST,ACHOLDERNAME,BANKACNO,BANKACCOUNTNO,BANKACCOUNTNUMBER,ACNO,ACCOUNTNO,ACCOUNTNUMBER,BANKACNUMBER,BANKACCOUNT,IFSCODE,IFSCCODE,BANKNAME,BANKBRANCHNAME,BRANCHNAME,SWIFTCODE,BankAccHolderName,BankDetails,BankIBAN
  </FETCH>
            </COLLECTION>
          </TDLMESSAGE>
        </TDL>
      </DESC>
    </BODY>
  </ENVELOPE>
  `;

  };

  export function getLedgerVouchersXML(
    company,
    fromDate,
    toDate
  ) {

    return `

  <ENVELOPE>

      <HEADER>

          <VERSION>1</VERSION>

          <TALLYREQUEST>
              Export
          </TALLYREQUEST>

          <TYPE>
              Collection
          </TYPE>

          <ID>
              LedgerVouchers
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

                  <SVFROMDATE TYPE="Date">
                      ${fromDate}
                  </SVFROMDATE>

                  <SVTODATE TYPE="Date">
                      ${toDate}
                  </SVTODATE>

              </STATICVARIABLES>

              <TDL>

                  <TDLMESSAGE>

                      <COLLECTION
                          NAME="LedgerVouchers"
                          ISMODIFY="No"
                      >

                          <TYPE>
                              Voucher
                          </TYPE>

                          <FETCH>

                              DATE,

                              VOUCHERTYPENAME,

                              VOUCHERNUMBER,

                              PARTYLEDGERNAME,

                              NARRATION,

                              ALLLEDGERENTRIES.LIST

                          </FETCH>

                      </COLLECTION>

                  </TDLMESSAGE>

              </TDL>

          </DESC>

          <DATA>
          </DATA>

      </BODY>

  </ENVELOPE>

  `;

  }
 export function getParentGroupsXML(
  company
) {

  return `

<ENVELOPE>

  <HEADER>

    <VERSION>1</VERSION>

    <TALLYREQUEST>
      Export
    </TALLYREQUEST>

    <TYPE>
      Collection
    </TYPE>

    <ID>
      Group Collection
    </ID>

  </HEADER>

  <BODY>

    <DESC>

      <STATICVARIABLES>

        <SVEXPORTFORMAT>
          $$SysName:XML
        </SVEXPORTFORMAT>

        <SVCURRENTCOMPANY>
          ${company}
        </SVCURRENTCOMPANY>

      </STATICVARIABLES>

      <TDL>

        <TDLMESSAGE>

          <COLLECTION
            NAME="Group Collection"
          >

            <TYPE>
              Group
            </TYPE>

            <FETCH>

              Name,
              Parent,
              PrimaryGroup,
              IsRevenue,
              IsDeemedPositive

            </FETCH>

          </COLLECTION>

        </TDLMESSAGE>

      </TDL>

    </DESC>

  </BODY>

</ENVELOPE>

`;

}