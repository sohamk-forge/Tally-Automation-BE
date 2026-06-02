/* ==================================================
   XML SAFE
================================================== */

const safe = (value = "") => {

  return String(value)

    .replace(/&/g, "&amp;")

    .replace(/</g, "&lt;")

    .replace(/>/g, "&gt;")

    .replace(/"/g, "&quot;")

    .trim();

};

/* ==================================================
   CREATE LEDGER XML
================================================== */

export const createLedgerXML = (data) => {

return `

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
${safe(data.company)}
</SVCURRENTCOMPANY>

</STATICVARIABLES>

</REQUESTDESC>

<REQUESTDATA>

<TALLYMESSAGE xmlns:UDF="TallyUDF">

<LEDGER
NAME="${safe(data.ledger_name)}"
RESERVEDNAME=""
ACTION="Create"
>

<!-- BASIC DETAILS -->

<NAME>
${safe(data.ledger_name)}
</NAME>

<MAILINGNAME>
${safe(data.ledger_name)}
</MAILINGNAME>

<PARENT>
${safe(data.parent)}
</PARENT>

<OPENINGBALANCE>
${data.opening_balance || 0}
</OPENINGBALANCE>

<ISBILLWISEON>
${data.bill_wise === "No" ? "No" : "Yes"}
</ISBILLWISEON>

<!-- MAILING DETAILS -->

<LEDMAILINGDETAILS.LIST>

<ADDRESS.LIST TYPE="String">

<ADDRESS>
${safe(data.address)}
</ADDRESS>

</ADDRESS.LIST>

<APPLICABLEFROM>
20250401
</APPLICABLEFROM>

<PINCODE>
${safe(data.pincode)}
</PINCODE>

<STATE>
${safe(data.state)}
</STATE>

<COUNTRY>
${safe(data.country || "India")}
</COUNTRY>

<CONTACTPERSON>
${safe(data.contact_person)}
</CONTACTPERSON>

<MOBILE>
${safe(data.mobile)}
</MOBILE>

<EMAIL>
${safe(data.email)}
</EMAIL>

</LEDMAILINGDETAILS.LIST>

<!-- EXTRA CONTACT DETAILS -->

<LEDSTATENAME>
${safe(data.state)}
</LEDSTATENAME>

<LEDCOUNTRYNAME>
${safe(data.country || "India")}
</LEDCOUNTRYNAME>

<LEDPINCODE>
${safe(data.pincode)}
</LEDPINCODE>

<LEDGERCONTACT>
${safe(data.contact_person)}
</LEDGERCONTACT>

<LEDGERPHONE>
${safe(data.phone)}
</LEDGERPHONE>

<LEDGERMOBILE>
${safe(data.mobile)}
</LEDGERMOBILE>

<EMAIL>
${safe(data.email)}
</EMAIL>

<LEDGERWEBSITE>
${safe(data.website)}
</LEDGERWEBSITE>

<!-- PAN DETAILS -->

<INCOMETAXNUMBER>
${safe(data.pan)}
</INCOMETAXNUMBER>

<!-- GST -->

<ISGSTAPPLICABLE>
Yes
</ISGSTAPPLICABLE>

<GSTREGISTRATIONTYPE>
${safe(data.gst_registration_type || "Regular")}
</GSTREGISTRATIONTYPE>

<PARTYGSTIN>
${safe(data.gstin)}
</PARTYGSTIN>

<PLACEOFSUPPLY>
${safe(data.state)}
</PLACEOFSUPPLY>

<!-- GST DETAILS -->

<GSTDETAILS.LIST>

<APPLICABLEFROM>
20250401
</APPLICABLEFROM>

<TAXABILITY>
Taxable
</TAXABILITY>

<GSTREGISTRATIONTYPE>
${safe(data.gst_registration_type || "Regular")}
</GSTREGISTRATIONTYPE>

<PARTYGSTIN>
${safe(data.gstin)}
</PARTYGSTIN>

<STATE>
${safe(data.state)}
</STATE>

</GSTDETAILS.LIST>

<!-- GST REGISTRATION DETAILS -->

<LEDGSTREGDETAILS.LIST>

<APPLICABLEFROM>
20250401
</APPLICABLEFROM>

<GSTREGISTRATIONTYPE>
${safe(data.gst_registration_type || "Regular")}
</GSTREGISTRATIONTYPE>

<GSTIN>
${safe(data.gstin)}
</GSTIN>

<STATE>
${safe(data.state)}
</STATE>

</LEDGSTREGDETAILS.LIST>

<!-- LANGUAGE DETAILS -->

<LANGUAGENAME.LIST>

<NAME.LIST TYPE="String">

<NAME>
${safe(data.ledger_name)}
</NAME>

</NAME.LIST>

<LANGUAGEID>
1033
</LANGUAGEID>

</LANGUAGENAME.LIST>

</LEDGER>

</TALLYMESSAGE>

</REQUESTDATA>

</IMPORTDATA>

</BODY>

</ENVELOPE>

`;

};

/* ==================================================
   CREATE BANK LEDGER XML
================================================== */

export const createBankLedgerXML = (data) => {

return `

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
${safe(data.company)}
</SVCURRENTCOMPANY>

</STATICVARIABLES>

</REQUESTDESC>

<REQUESTDATA>

<TALLYMESSAGE xmlns:UDF="TallyUDF">

<LEDGER
NAME="${safe(data.ledger_name)}"
RESERVEDNAME=""
ACTION="Create"
>

<!-- BASIC DETAILS -->

<NAME>
${safe(data.ledger_name)}
</NAME>

<MAILINGNAME>
${safe(data.ledger_name)}
</MAILINGNAME>

<PARENT>
${safe(data.parent || "Bank Accounts")}
</PARENT>

<OPENINGBALANCE>
${data.opening_balance || 0}
</OPENINGBALANCE>

<ISBILLWISEON>
No
</ISBILLWISEON>

<ISBANKINGLEDGER>
Yes
</ISBANKINGLEDGER>

<ISCHEQUEPRINTINGENABLED>
Yes
</ISCHEQUEPRINTINGENABLED>

<ISPAYUPLOAD>
Yes
</ISPAYUPLOAD>

<!-- BANK DETAILS -->

<BANKNAME>
${safe(data.bank_name)}
</BANKNAME>

<BANKBRANCHNAME>
${safe(data.branch_name)}
</BANKBRANCHNAME>

<!-- MAILING DETAILS -->

<LEDMAILINGDETAILS.LIST>

<ADDRESS.LIST TYPE="String">

<ADDRESS>
${safe(data.address)}
</ADDRESS>

</ADDRESS.LIST>

<APPLICABLEFROM>
${safe(data.applicable_from || "20250401")}
</APPLICABLEFROM>

<PINCODE>
${safe(data.pincode)}
</PINCODE>

<STATE>
${safe(data.state)}
</STATE>

<COUNTRY>
${safe(data.country || "India")}
</COUNTRY>

<CONTACTPERSON>
${safe(data.contact_person)}
</CONTACTPERSON>

<MOBILE>
${safe(data.mobile)}
</MOBILE>

<EMAIL>
${safe(data.email)}
</EMAIL>

<IFSCCODE>
${safe(data.ifsc_code)}
</IFSCCODE>

<IFSCODE>
${safe(data.ifsc_code)}
</IFSCODE>

</LEDMAILINGDETAILS.LIST>

<!-- EXTRA DETAILS -->

<LEDSTATENAME>
${safe(data.state)}
</LEDSTATENAME>

<LEDCOUNTRYNAME>
${safe(data.country || "India")}
</LEDCOUNTRYNAME>

<LEDPINCODE>
${safe(data.pincode)}
</LEDPINCODE>

<LEDGERCONTACT>
${safe(data.contact_person)}
</LEDGERCONTACT>

<LEDGERPHONE>
${safe(data.mobile)}
</LEDGERPHONE>

<LEDGERMOBILE>
${safe(data.mobile)}
</LEDGERMOBILE>

<!-- BANK ACCOUNT DETAILS -->

<BANKALLOCATIONS.LIST>

<BANKACCHOLDERNAME>
${safe(data.account_holder)}
</BANKACCHOLDERNAME>

<BANKDETAILS>
${safe(data.account_number)}
</BANKDETAILS>

<BANKNAME>
${safe(data.bank_name)}
</BANKNAME>

<BANKBRANCHNAME>
${safe(data.branch_name)}
</BANKBRANCHNAME>

<BRANCHNAME>
${safe(data.branch_name)}
</BRANCHNAME>

<BANKIFSC>
${safe(data.ifsc_code)}
</BANKIFSC>

<IFSCCODE>
${safe(data.ifsc_code)}
</IFSCCODE>

<IFSCODE>
${safe(data.ifsc_code)}
</IFSCODE>

<SWIFTCODE>
${safe(data.swift_code)}
</SWIFTCODE>

<BANKIBAN>
${safe(data.iban)}
</BANKIBAN>

</BANKALLOCATIONS.LIST>

<!-- LANGUAGE -->

<LANGUAGENAME.LIST>

<NAME.LIST TYPE="String">

<NAME>
${safe(data.ledger_name)}
</NAME>

</NAME.LIST>

<LANGUAGEID>
1033
</LANGUAGEID>

</LANGUAGENAME.LIST>

</LEDGER>

</TALLYMESSAGE>

</REQUESTDATA>

</IMPORTDATA>

</BODY>

</ENVELOPE>

`;

};

export const createOdBankXML = (data) => {

return `

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
                        ${safe(data.company)}
                    </SVCURRENTCOMPANY>

                </STATICVARIABLES>

            </REQUESTDESC>

            <REQUESTDATA>

                <TALLYMESSAGE xmlns:UDF="TallyUDF">

                    <LEDGER
                        NAME="${safe(data.ledger_name)}"
                        RESERVEDNAME=""
                        ACTION="Create"
                    >

                        <!-- BASIC DETAILS -->

                        <NAME>
                            ${safe(data.ledger_name)}
                        </NAME>

                        <MAILINGNAME>
                            ${safe(data.ledger_name)}
                        </MAILINGNAME>

                        <!-- OD / OCC GROUP -->

                        <PARENT>
                            Bank OD A/c
                        </PARENT>

                        <!-- OD FLAGS -->

                        <ISODACCOUNT>
                            Yes
                        </ISODACCOUNT>

                        <ISLOANACCOUNT>
                            Yes
                        </ISLOANACCOUNT>

                        <ISINTERESTON>
                            No
                        </ISINTERESTON>

                        <!-- OPENING BALANCE -->

                        <OPENINGBALANCE>
                            ${data.opening_balance || 0}
                        </OPENINGBALANCE>

                        <!-- OD LIMIT -->

                        <ODLIMIT>
                            ${data.od_limit || 0}
                        </ODLIMIT>

                        <SETODLIMIT>
                            ${data.od_limit || 0}
                        </SETODLIMIT>

                        <!-- BANKING -->

                        <ISBILLWISEON>
                            No
                        </ISBILLWISEON>

                        <ISBANKINGLEDGER>
                            Yes
                        </ISBANKINGLEDGER>

                        <ISCHEQUEPRINTINGENABLED>
                            Yes
                        </ISCHEQUEPRINTINGENABLED>

                        <ISPAYUPLOAD>
                            Yes
                        </ISPAYUPLOAD>

                        <!-- BANK DETAILS -->

                        <BANKNAME>
                            ${safe(data.bank_name)}
                        </BANKNAME>

                        <BANKBRANCHNAME>
                            ${safe(data.branch_name)}
                        </BANKBRANCHNAME>

                        <!-- MAILING DETAILS -->

                        <LEDMAILINGDETAILS.LIST>

                            <ADDRESS.LIST TYPE="String">

                                <ADDRESS>
                                    ${safe(data.address)}
                                </ADDRESS>

                            </ADDRESS.LIST>

                            <APPLICABLEFROM>
                                20250401
                            </APPLICABLEFROM>

                            <PINCODE>
                                ${safe(data.pincode)}
                            </PINCODE>

                            <STATE>
                                ${safe(data.state)}
                            </STATE>

                            <COUNTRY>
                                ${safe(data.country || "India")}
                            </COUNTRY>

                            <CONTACTPERSON>
                                ${safe(data.contact_person)}
                            </CONTACTPERSON>

                            <MOBILE>
                                ${safe(data.mobile)}
                            </MOBILE>

                            <EMAIL>
                                ${safe(data.email)}
                            </EMAIL>

                            <IFSCCODE>
                                ${safe(data.ifsc_code)}
                            </IFSCCODE>

                            <IFSCODE>
                                ${safe(data.ifsc_code)}
                            </IFSCODE>

                        </LEDMAILINGDETAILS.LIST>

                        <!-- EXTRA DETAILS -->

                        <LEDSTATENAME>
                            ${safe(data.state)}
                        </LEDSTATENAME>

                        <LEDCOUNTRYNAME>
                            ${safe(data.country || "India")}
                        </LEDCOUNTRYNAME>

                        <LEDPINCODE>
                            ${safe(data.pincode)}
                        </LEDPINCODE>

                        <LEDGERCONTACT>
                            ${safe(data.contact_person)}
                        </LEDGERCONTACT>

                        <LEDGERPHONE>
                            ${safe(data.mobile)}
                        </LEDGERPHONE>

                        <LEDGERMOBILE>
                            ${safe(data.mobile)}
                        </LEDGERMOBILE>

                        <!-- BANK ACCOUNT DETAILS -->

                        <BANKALLOCATIONS.LIST>

                            <BANKACCHOLDERNAME>
                                ${safe(data.account_holder)}
                            </BANKACCHOLDERNAME>

                            <BANKDETAILS>
                                ${safe(data.account_number)}
                            </BANKDETAILS>

                            <BANKACCOUNTNAME>
                                ${safe(data.bank_name)}
                            </BANKACCOUNTNAME>

                            <BANKNAME>
                                ${safe(data.bank_name)}
                            </BANKNAME>

                            <BANKBRANCHNAME>
                                ${safe(data.branch_name)}
                            </BANKBRANCHNAME>

                            <BRANCHNAME>
                                ${safe(data.branch_name)}
                            </BRANCHNAME>

                            <BANKIFSC>
                                ${safe(data.ifsc_code)}
                            </BANKIFSC>

                            <IFSCCODE>
                                ${safe(data.ifsc_code)}
                            </IFSCCODE>

                            <IFSCODE>
                                ${safe(data.ifsc_code)}
                            </IFSCODE>

                            <SWIFTCODE>
                                ${safe(data.swift_code)}
                            </SWIFTCODE>

                            <SETASDEFAULTACCT>
                                Yes
                            </SETASDEFAULTACCT>

                            <ISDEFAULTBANK>
                                Yes
                            </ISDEFAULTBANK>

                        </BANKALLOCATIONS.LIST>

                        <!-- LANGUAGE -->

                        <LANGUAGENAME.LIST>

                            <NAME.LIST TYPE="String">

                                <NAME>
                                    ${safe(data.ledger_name)}
                                </NAME>

                            </NAME.LIST>

                            <LANGUAGEID>
                                1033
                            </LANGUAGEID>

                        </LANGUAGENAME.LIST>

                    </LEDGER>

                </TALLYMESSAGE>

            </REQUESTDATA>

        </IMPORTDATA>

    </BODY>

</ENVELOPE>

`;

};


export const getStockItemCreateXML = ({
  company,
  itemName,
  alias,
  unit,
  description,
  hsnCode,
  cgst,
  sgst,
  igst,
  gstApplicable,
  parentGroup
}) => {

  const finalGSTApplicable = gstApplicable || "Not Applicable";

  let gstDetailsSection = "";

  if (finalGSTApplicable === "Applicable") {

    gstDetailsSection = `

      <GSTDETAILS.LIST>

        <APPLICABLEFROM>20260401</APPLICABLEFROM>

        <TAXABILITY>Taxable</TAXABILITY>

        <SRCOFGSTDETAILS>Specify Details Here</SRCOFGSTDETAILS>

        <STATEWISEDETAILS.LIST>

          <STATENAME>&#4; Any</STATENAME>

          <RATEDETAILS.LIST>
            <GSTRATEDUTYHEAD>CGST</GSTRATEDUTYHEAD>
            <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>
            <GSTRATE>${cgst || 0}</GSTRATE>
          </RATEDETAILS.LIST>

          <RATEDETAILS.LIST>
            <GSTRATEDUTYHEAD>SGST/UTGST</GSTRATEDUTYHEAD>
            <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>
            <GSTRATE>${sgst || 0}</GSTRATE>
          </RATEDETAILS.LIST>

          <RATEDETAILS.LIST>
            <GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD>
            <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>
            <GSTRATE>${igst || 0}</GSTRATE>
          </RATEDETAILS.LIST>

        </STATEWISEDETAILS.LIST>

      </GSTDETAILS.LIST>

      <HSNDETAILS.LIST>

        <APPLICABLEFROM>20260401</APPLICABLEFROM>

        <HSNCODE>${hsnCode || ""}</HSNCODE>

        <SRCOFHSNDETAILS>Specify Details Here</SRCOFHSNDETAILS>

      </HSNDETAILS.LIST>

    `;
  }

  return `

<ENVELOPE>

 <HEADER>
  <TALLYREQUEST>Import Data</TALLYREQUEST>
 </HEADER>

 <BODY>

  <IMPORTDATA>

   <REQUESTDESC>

    <REPORTNAME>All Masters</REPORTNAME>

    <STATICVARIABLES>

      <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>

    </STATICVARIABLES>

   </REQUESTDESC>

   <REQUESTDATA>

    <TALLYMESSAGE xmlns:UDF="TallyUDF">

      <STOCKITEM NAME="${itemName}" ACTION="Create">

        <NAME>${itemName}</NAME>

        <PARENT>${parentGroup}</PARENT>

        <CATEGORY>&#4; Not Applicable</CATEGORY>

        <GSTAPPLICABLE>&#4; ${finalGSTApplicable}</GSTAPPLICABLE>

        <TAXCLASSIFICATIONNAME>&#4; Not Applicable</TAXCLASSIFICATIONNAME>

        <GSTTYPEOFSUPPLY>Goods</GSTTYPEOFSUPPLY>

        <COSTINGMETHOD>Avg. Cost</COSTINGMETHOD>

        <VALUATIONMETHOD>Avg. Price</VALUATIONMETHOD>

        <BASEUNITS>${unit}</BASEUNITS>

        <ADDITIONALUNITS>&#4; Not Applicable</ADDITIONALUNITS>

        <DESCRIPTION>${description}</DESCRIPTION>

        ${gstDetailsSection}

        <LANGUAGENAME.LIST>

          <NAME.LIST TYPE="String">

            <NAME>${itemName}</NAME>

            <NAME>${alias || itemName}</NAME>

          </NAME.LIST>

          <LANGUAGEID>1033</LANGUAGEID>

        </LANGUAGENAME.LIST>

      </STOCKITEM>

    </TALLYMESSAGE>

   </REQUESTDATA>

  </IMPORTDATA>

 </BODY>

</ENVELOPE>

`;
};