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

    <ID TYPE="Name">${ledgerName}</ID>

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

     <FETCH>PARTYGSTIN</FETCH>

<FETCH>LEDGSTREGDETAILS.*</FETCH>

<FETCH>GUID</FETCH>

<FETCH>MASTERID</FETCH>

<FETCH>ALTERID</FETCH>

      </FETCHLIST>

    </DESC>

  </BODY>

</ENVELOPE>
`;

};


export const getGroupSummaryCRXML = (company) => {

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

        <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>

        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>

      </STATICVARIABLES>

      <TDL>

        <TDLMESSAGE>

        <SYSTEM TYPE="Formulae" NAME="CreditorFilter">
    $Parent = "Sundry Creditors"
</SYSTEM>

<COLLECTION NAME="GroupSummaryCR">

    <TYPE>Ledger</TYPE>

    <FILTERS>CreditorFilter</FILTERS>

    <FETCH>

              NAME,
              ALIAS,
              PARENT,

              MAILINGNAME,
              ADDRESS,

              COUNTRYNAME,
              STATENAME,
              STATE,
              LEDSTATENAME,
              LEDCOUNTRYNAME,

              PINCODE,

              PHONE,
              PHONENUMBER,
              LEDGERPHONE,

              MOBILE,
              MOBILENUMBER,
              LEDGERMOBILE,

              FAX,

              EMAIL,
              LEDGEREMAIL,

              CONTACTPERSON,
              CONTACTDETAILS.*,

              PARTYGSTIN,
              GSTREGISTRATIONTYPE,
              PARTYREGISTRATIONTYPE,

              GSTIN,
              PLACEOFSUPPLY,

              LEDGSTREGDETAILS.*,

              INCOMETAXNUMBER,

              BANKNAME,
              BANKACCOUNTNUMBER,
              BANKBRANCHNAME,
              BANKIFSCODE,

              CREDITPERIOD,
              CREDITLIMIT,

              OPENINGBALANCE,
              CLOSINGBALANCE,

              GUID,
              MASTERID,
              ALTERID

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
                <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
                <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
            </STATICVARIABLES>

            <TDL>
                <TDLMESSAGE>

                    <SYSTEM TYPE="Formulae" NAME="BankFilter">
                        $Parent = "Bank OD A/c" OR $Parent = "Bank Accounts" OR $Parent = "Bank Accounts"
                    </SYSTEM>

                    <COLLECTION NAME="GroupSummaryBank">

                        <TYPE>Ledger</TYPE>

                        <FILTERS>BankFilter</FILTERS>
<FETCH>

    NAME,
    PARENT,

    MAILINGNAME,
    ADDRESS,

    STATENAME,
    LEDSTATENAME,
    STATE,

    COUNTRYNAME,

    PINCODE,

    GSTIN,
    PARTYGSTIN,
    GSTREGISTRATIONTYPE,
    ISGSTAPPLICABLE,
    LEDGERGSTREGDETAILS.LIST,

    ACHOLDERNAME,
    BANKACNO,
    BANKACCOUNTNO,
    BANKACCOUNTNUMBER,
    ACNO,
    ACCOUNTNO,
    ACCOUNTNUMBER,
    BANKACNUMBER,
    BANKACCOUNT,

    IFSCODE,
    IFSCCODE,

    BANKNAME,
    BANKBRANCHNAME,
    BRANCHNAME,

    SWIFTCODE,

    BankAccHolderName,
    BankDetails,
    BankIBAN,

    PHONE,
    PHONENUMBER,
    LEDGERPHONE,

    MOBILE,
    MOBILENUMBER,
    LEDGERMOBILE,

    EMAIL,
    LEDGEREMAIL,

    CONTACTPERSON,
    CONTACTDETAILS.*,

    OPENINGBALANCE,
    CLOSINGBALANCE,

    ODLIMIT,

    GUID,
    MASTERID,
    ALTERID

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
export const getGroupBalanceXML = (

  company,
  groupName

) => {

  return `

<ENVELOPE>

    <HEADER>

        <VERSION>1</VERSION>

        <TALLYREQUEST>
            Export
        </TALLYREQUEST>

        <TYPE>
            Object
        </TYPE>

        <SUBTYPE>
            Group
        </SUBTYPE>

        <ID TYPE="Name">
            ${groupName}
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

            <FETCHLIST>

                <FETCH>Name</FETCH>

                <FETCH>Parent</FETCH>

                <FETCH>ClosingBalance</FETCH>

                <FETCH>OpeningBalance</FETCH>

            </FETCHLIST>

        </DESC>

    </BODY>

</ENVELOPE>

  `;

};

/* ==================================================
   ALL PARENT GROUP DETAILS XML
================================================== */

export const getAllParentGroupDetailsXML = (

  company,
  groupName

) => {

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
      AllParentGroupDetails
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

      <TDL>

        <TDLMESSAGE>

          <COLLECTION
            NAME="AllParentGroupDetails"
          >

            <TYPE>
              Ledger
            </TYPE>

            <CHILDOF>
              ${groupName}
            </CHILDOF>

            <FETCH>

              NAME,

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
/* ===================================================
   PROFIT LOSS XML GENERATOR
=================================================== */
export const getProfitLossXML = (

  company,

  fromDate,

  toDate

) => `

<ENVELOPE>

  <HEADER>

    <VERSION>1</VERSION>

    <TALLYREQUEST>Export</TALLYREQUEST>

    <TYPE>Collection</TYPE>

    <ID>ProfitLossCollection</ID>

  </HEADER>

  <BODY>

    <DESC>

      <STATICVARIABLES>

        <SVCURRENTCOMPANY>
          ${company}
        </SVCURRENTCOMPANY>

        <SVFROMDATE TYPE="Date">
          ${fromDate}
        </SVFROMDATE>

        <SVTODATE TYPE="Date">
          ${toDate}
        </SVTODATE>

        <SVEXPORTFORMAT>
          $$SysName:XML
        </SVEXPORTFORMAT>

      </STATICVARIABLES>

      <TDL>

        <TDLMESSAGE>

          <COLLECTION NAME="ProfitLossCollection">

            <TYPE>Group</TYPE>

            <FETCH>
              Name,
              Parent,
              ClosingBalance
            </FETCH>

            <FILTERS>
              IsProfitLossGroup
            </FILTERS>

          </COLLECTION>

          <SYSTEM TYPE="Formulae" NAME="IsProfitLossGroup">

            $$IsEqual:$Name:"Sales Accounts"
            OR
            $$IsEqual:$Name:"Purchase Accounts"
            OR
            $$IsEqual:$Name:"Direct Expenses"
            OR
            $$IsEqual:$Name:"Direct Incomes"
            OR
            $$IsEqual:$Name:"Indirect Expenses"
            OR
            $$IsEqual:$Name:"Indirect Incomes"
            OR
            $$IsEqual:$Name:"Stock-in-hand"

          </SYSTEM>

        </TDLMESSAGE>

      </TDL>

    </DESC>

  </BODY>

</ENVELOPE>

`;
export const getStockGroupSummaryXML = (
  company
) => {

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
      StockItemSummary
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

      <TDL>

        <TDLMESSAGE>

          <COLLECTION
            NAME="StockItemSummary"
          >

            <TYPE>
              StockItem
            </TYPE>

            <FETCH>

              NAME,

              PARENT,

              HSNDETAILS.LIST,

              CLOSINGBALANCE,

              CLOSINGVALUE

            </FETCH>

          </COLLECTION>

        </TDLMESSAGE>

      </TDL>

    </DESC>

  </BODY>

</ENVELOPE>

`;

};

/* ===================================================
   SIMPLE UNITS XML
=================================================== */

export const getUnitsXML = (company) => {

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
            TSPLSimpleUnits
        </ID>

    </HEADER>

    <BODY>

        <DESC>

            <STATICVARIABLES>

                <SVEXPORTFORMAT>
                    XML
                </SVEXPORTFORMAT>

                <SVCURRENTCOMPANY>
                    ${company}
                </SVCURRENTCOMPANY>

            </STATICVARIABLES>

            <TDL>

                <TDLMESSAGE>

                    <COLLECTION
                        NAME="TSPLSimpleUnits"
                        ISMODIFY="No"
                        ISFIXED="No"
                        ISINITIALIZE="No"
                        ISOPTION="No"
                        ISINTERNAL="No"
                    >

                        <TYPE>
                            Unit
                        </TYPE>

                        <NATIVEMETHOD>
                            Name,
                            OriginalName,
                            IsSimpleUnit
                        </NATIVEMETHOD>

                        <FILTERS>
                            TSPLSimpleUnitsOnly
                        </FILTERS>

                    </COLLECTION>

                    <SYSTEM
                        TYPE="Formulae"
                        NAME="TSPLSimpleUnitsOnly"
                    >

                        $IsSimpleUnit

                    </SYSTEM>

                </TDLMESSAGE>

            </TDL>

        </DESC>

    </BODY>

</ENVELOPE>

  `;

};


export const getAllLedgersXML = (company) => {

  return `
<ENVELOPE>

  <HEADER>

    <VERSION>1</VERSION>

    <TALLYREQUEST>Export</TALLYREQUEST>

    <TYPE>Collection</TYPE>

    <ID>AllLedgers</ID>

  </HEADER>

  <BODY>

    <DESC>

      <STATICVARIABLES>

        <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>

        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>

      </STATICVARIABLES>

      <TDL>

        <TDLMESSAGE>

          <COLLECTION NAME="AllLedgers">

            <TYPE>Ledger</TYPE>

            <FETCH>

              NAME,
              ALIAS,
              PARENT,

              MAILINGNAME,
              ADDRESS,

              COUNTRYNAME,
              STATENAME,
              STATE,
              LEDSTATENAME,
              LEDCOUNTRYNAME,

              PINCODE,

              PHONE,
              PHONENUMBER,
              LEDGERPHONE,

              MOBILE,
              MOBILENUMBER,
              LEDGERMOBILE,

              FAX,

              EMAIL,
              LEDGEREMAIL,

              CONTACTPERSON,
              CONTACTDETAILS.*,

              PARTYGSTIN,
              GSTREGISTRATIONTYPE,
              PARTYREGISTRATIONTYPE,

              GSTIN,
              PLACEOFSUPPLY,

              LEDGSTREGDETAILS.*,

              INCOMETAXNUMBER,

              BANKNAME,
              BANKACCOUNTNUMBER,
              BANKBRANCHNAME,
              BANKIFSCODE,

              CREDITPERIOD,
              CREDITLIMIT,

              OPENINGBALANCE,
              CLOSINGBALANCE,

              GUID,
              MASTERID,
              ALTERID

            </FETCH>

          </COLLECTION>

        </TDLMESSAGE>

      </TDL>

    </DESC>

  </BODY>

</ENVELOPE>
`;
};



export const getPurchaseSalesLedgersXML = (company) => `
<ENVELOPE>
    <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Collection</TYPE>
        <ID>PurchaseSalesLedgers</ID>
    </HEADER>

    <BODY>
        <DESC>

            <STATICVARIABLES>
                <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
                <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
            </STATICVARIABLES>

            <TDL>
                <TDLMESSAGE>

                    <COLLECTION
                        NAME="PurchaseSalesLedgers"
                        ISMODIFY="No"
                    >
                        <TYPE>Ledger</TYPE>

                        <FILTER>
                            IsPurchaseOrSales
                        </FILTER>

                        <FETCH>
                            NAME,
                            PARENT,
                            MASTERID,
                            ALTERID,
                            GUID
                        </FETCH>

                    </COLLECTION>

                    <SYSTEM
                        TYPE="Formulae"
                        NAME="IsPurchaseOrSales"
                    >
                        $Parent = "Purchase Accounts"
                        OR
                        $Parent = "Sales Accounts"
                    </SYSTEM>

                </TDLMESSAGE>
            </TDL>

        </DESC>
    </BODY>
</ENVELOPE>
`;

export const getGodownsXML = (company) => {

  return `
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export Data</TALLYREQUEST>
  </HEADER>

  <BODY>

    <EXPORTDATA>

      <REQUESTDESC>

        <REPORTNAME>
          Godown Summary
        </REPORTNAME>

        <STATICVARIABLES>

          <SVEXPORTFORMAT>
            $$SysName:XML
          </SVEXPORTFORMAT>

          <SVCURRENTCOMPANY>
            ${company}
          </SVCURRENTCOMPANY>

        </STATICVARIABLES>

      </REQUESTDESC>

    </EXPORTDATA>

  </BODY>

</ENVELOPE>
`;

};