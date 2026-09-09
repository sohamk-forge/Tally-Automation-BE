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
// Shared GST-rate-by-duty-head formulas, used by both the StockItem and
// StockGroup GST exports below. Tally's GSTRATEDUTYHEAD field holds the
// short duty-head codes actually seen in real exports ("IGST", "CGST",
// "SGST/UTGST", "Cess") — NOT the long names ("Integrated Tax" etc.), which
// never match anything and silently produce blank rates. Confirmed live
// against a running Tally instance before writing this.
const GST_DUTY_HEAD_FORMULAE = `
<SYSTEM TYPE="Formulae" NAME="IsIGST">$GSTRatedutyhead = "IGST"</SYSTEM>
<SYSTEM TYPE="Formulae" NAME="IsCGST">$GSTRatedutyhead = "CGST"</SYSTEM>
<SYSTEM TYPE="Formulae" NAME="IsSGST">$GSTRatedutyhead = "SGST/UTGST"</SYSTEM>
<SYSTEM TYPE="Formulae" NAME="IsCess">$GSTRatedutyhead = "Cess"</SYSTEM>`;

// Rate/HSN methods shared by both collections below. HSN lives under the
// item/group's own HSNDetails list — a SEPARATE date-effective list from
// GSTDetails, not nested inside it (confirmed live: reading HSN from
// $GSTDetails[Last].HSNCode came back blank even for items with HSN set in
// Tally; $HSNDetails[Last].HSNCode is the correct path).
const gstRateMethods = (objectType) => `
<METHOD>HSNCode:$HSNDetails[Last].HSNCode</METHOD>
<METHOD>GSTRate:$GSTDetails[Last].StateWiseDetails[1].RateDetails[1].GSTRate</METHOD>
<METHOD>IGSTRate:$(${objectType},$Name).GSTDetails[Last].StateWiseDetails[1].RateDetails[1,@@IsIGST].GSTRate</METHOD>
<METHOD>CGSTRate:$(${objectType},$Name).GSTDetails[Last].StateWiseDetails[1].RateDetails[1,@@IsCGST].GSTRate</METHOD>
<METHOD>SGSTRate:$(${objectType},$Name).GSTDetails[Last].StateWiseDetails[1].RateDetails[1,@@IsSGST].GSTRate</METHOD>
<METHOD>CessRate:$(${objectType},$Name).GSTDetails[Last].StateWiseDetails[1].RateDetails[1,@@IsCess].GSTRate</METHOD>
<METHOD>GSTApplicable:$GSTDetails[Last].Applicability</METHOD>`;

export const getStockGroupSummaryXML = (company) => {
  return `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>StockItemSummary</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          ${GST_DUTY_HEAD_FORMULAE}
          <COLLECTION NAME="StockItemSummary" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes" ISOPTION="No" ISINTERNAL="No">
            <TYPE>StockItem</TYPE>
            <NATIVEMETHOD>Name</NATIVEMETHOD>
            <NATIVEMETHOD>Parent</NATIVEMETHOD>
            <NATIVEMETHOD>BaseUnits</NATIVEMETHOD>
            <NATIVEMETHOD>ClosingBalance</NATIVEMETHOD>
            <NATIVEMETHOD>ClosingValue</NATIVEMETHOD>
            ${gstRateMethods("StockItem")}
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
};

// Stock-GROUP-level GST — a business can set GST at the group level instead
// of per item; items with no GST override of their own fall back to this.
// Same validated formula pattern as getStockGroupSummaryXML above, just
// targeting Tally's StockGroup object type instead of StockItem.
export const getStockGroupGSTXML = (company) => {
  return `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>StockGroupGST</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          ${GST_DUTY_HEAD_FORMULAE}
          <COLLECTION NAME="StockGroupGST" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes" ISOPTION="No" ISINTERNAL="No">
            <TYPE>StockGroup</TYPE>
            <NATIVEMETHOD>Name</NATIVEMETHOD>
            <NATIVEMETHOD>Parent</NATIVEMETHOD>
            ${gstRateMethods("StockGroup")}
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
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
export const getSalesGroupXML = (company) => {
  return `
<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE>
  <ID>SalesGroupOnly</ID>
 </HEADER>
 <BODY>
  <DESC>
   <STATICVARIABLES>
    <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
   </STATICVARIABLES>
   <TDL>
    <TDLMESSAGE>
     <SYSTEM TYPE="Formulae" NAME="SalesGroupFilter">
      $$IsEqual:$ReservedName:"Sales Accounts"
     </SYSTEM>
     <COLLECTION NAME="SalesGroupOnly">
      <TYPE>Group</TYPE>
      <FILTERS>SalesGroupFilter</FILTERS>
      <FETCH>Name</FETCH>
      <FETCH>ReservedName</FETCH>
      <FETCH>Parent</FETCH>
      <FETCH>OpeningBalance</FETCH>
      <FETCH>ClosingBalance</FETCH>
      <FETCH>GUID</FETCH>
      <FETCH>MasterID</FETCH>
      <FETCH>AlterID</FETCH>
     </COLLECTION>
    </TDLMESSAGE>
   </TDL>
  </DESC>
 </BODY>
</ENVELOPE>
  `;
};

export const getPurchaseGroupXML = (company) => {
  return `
<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE>
  <ID>PurchaseGroupOnly</ID>
 </HEADER>
 <BODY>
  <DESC>
   <STATICVARIABLES>
    <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
   </STATICVARIABLES>
   <TDL>
    <TDLMESSAGE>
     <SYSTEM TYPE="Formulae" NAME="PurchaseGroupFilter">
      $$IsEqual:$ReservedName:"Purchase Accounts"
     </SYSTEM>
     <COLLECTION NAME="PurchaseGroupOnly">
      <TYPE>Group</TYPE>
      <FILTERS>PurchaseGroupFilter</FILTERS>
      <FETCH>Name</FETCH>
      <FETCH>ReservedName</FETCH>
      <FETCH>Parent</FETCH>
      <FETCH>OpeningBalance</FETCH>
      <FETCH>ClosingBalance</FETCH>
      <FETCH>GUID</FETCH>
      <FETCH>MasterID</FETCH>
      <FETCH>AlterID</FETCH>
     </COLLECTION>
    </TDLMESSAGE>
   </TDL>
  </DESC>
 </BODY>
</ENVELOPE>
  `;
};

export const getStockInHandXML = (company) => {
  return `
<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE>
  <ID>StockInHandOnly</ID>
 </HEADER>
 <BODY>
  <DESC>
   <STATICVARIABLES>
    <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
   </STATICVARIABLES>
   <TDL>
    <TDLMESSAGE>
     <SYSTEM TYPE="Formulae" NAME="StockInHandFilter">
      $$IsEqual:$Name:"Stock-in-Hand" OR $$IsEqual:$Name:"Stock in Hand"
     </SYSTEM>
     <COLLECTION NAME="StockInHandOnly">
      <TYPE>Group</TYPE>
      <FILTERS>StockInHandFilter</FILTERS>
      <FETCH>Name</FETCH>
      <FETCH>Parent</FETCH>
      <FETCH>OpeningBalance</FETCH>
      <FETCH>ClosingBalance</FETCH>
     </COLLECTION>
    </TDLMESSAGE>
   </TDL>
  </DESC>
 </BODY>
</ENVELOPE>
  `;
};
export const getCompanyDetailsXML = (company) => {
  return `
<ENVELOPE>
    <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Object</TYPE>
        <SUBTYPE>Company</SUBTYPE>
        <ID TYPE="Name">${company}</ID>
    </HEADER>

    <BODY>
        <DESC>
            <STATICVARIABLES>
                <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
                <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
            </STATICVARIABLES>

            <FETCHLIST>
                <FETCH>NAME</FETCH>
                <FETCH>ADDRESS</FETCH>
                <FETCH>EMAIL</FETCH>
                <FETCH>STATENAME</FETCH>
                <FETCH>ISGSTON</FETCH>
                <FETCH>GSTREGISTRATIONTYPE</FETCH>
            </FETCHLIST>
        </DESC>
    </BODY>
</ENVELOPE>
`;
};
export const getCompanyGSTDetailsXML = (company) => {
  return `
<ENVELOPE>
    <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Collection</TYPE>
        <ID>TaxUnitCollection</ID>
    </HEADER>

    <BODY>
        <DESC>

            <STATICVARIABLES>
                <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
                <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
            </STATICVARIABLES>

            <TDL>
                <TDLMESSAGE>

                    <COLLECTION NAME="TaxUnitCollection">
                        <TYPE>Tax Unit</TYPE>

                        <FETCH>NAME</FETCH>
                        <FETCH>GSTREGNUMBER</FETCH>
                        <FETCH>GSTREGISTRATIONDETAILS.LIST</FETCH>

                    </COLLECTION>

                </TDLMESSAGE>
            </TDL>

        </DESC>
    </BODY>
</ENVELOPE>
`;
};
export const getProfitLossReportXML = (company) => {
  return `
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export Data</TALLYREQUEST>
  </HEADER>

  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>

        <REPORTNAME>Profit and Loss</REPORTNAME>

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

// Checks whether a Sales voucher with the given reference number already
// exists in Tally — used before re-pushing a previously-failed/retried
// invoice, so a voucher that actually succeeded on an earlier attempt
// (but wasn't recorded as such on our side) isn't sent to Tally a second
// time, where it would be silently rejected as a duplicate
// (CREATED=0/ALTERED=0/EXCEPTIONS=1, no LINEERROR).
export const getSalesVoucherExistsXML = (company, referenceNo) => {
  return `
<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE>
  <ID>SalesRefCheck</ID>
 </HEADER>
 <BODY>
  <DESC>
   <STATICVARIABLES>
    <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
   </STATICVARIABLES>
   <TDL>
    <TDLMESSAGE>
     <SYSTEM TYPE="Formulae" NAME="RefMatch">
      $VoucherTypeName = "Sales" AND $Reference = "${referenceNo}"
     </SYSTEM>
     <COLLECTION NAME="SalesRefCheck">
      <TYPE>Voucher</TYPE>
      <FILTERS>RefMatch</FILTERS>
      <FETCH>VOUCHERNUMBER</FETCH>
      <FETCH>REFERENCE</FETCH>
      <FETCH>DATE</FETCH>
     </COLLECTION>
    </TDLMESSAGE>
   </TDL>
  </DESC>
 </BODY>
</ENVELOPE>
  `;
};