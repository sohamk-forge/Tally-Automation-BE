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
                        ${data.company || ""}
                    </SVCURRENTCOMPANY>

                </STATICVARIABLES>

            </REQUESTDESC>

            <REQUESTDATA>

                <TALLYMESSAGE xmlns:UDF="TallyUDF">

                    <LEDGER
                        NAME="${data.ledger_name || ""}"
                        RESERVEDNAME=""
                        ACTION="Create"
                    >

                        <!-- BASIC DETAILS -->

                        <NAME>
                            ${data.ledger_name || ""}
                        </NAME>

                        <MAILINGNAME>
                            ${data.ledger_name || ""}
                        </MAILINGNAME>

                        <PARENT>
                            ${data.parent || "Bank Accounts"}
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
                            ${data.bank_name || ""}
                        </BANKNAME>

                        <BANKBRANCHNAME>
                            ${data.branch_name || ""}
                        </BANKBRANCHNAME>

                        <!-- MAILING DETAILS -->

                        <LEDMAILINGDETAILS.LIST>

                            <ADDRESS.LIST TYPE="String">

                                <ADDRESS>
                                    ${data.address || ""}
                                </ADDRESS>

                            </ADDRESS.LIST>

                            <APPLICABLEFROM>
                                ${data.applicable_from || "20250401"}
                            </APPLICABLEFROM>

                            <PINCODE>
                                ${data.pincode || ""}
                            </PINCODE>

                            <STATE>
                                ${data.state || ""}
                            </STATE>

                            <COUNTRY>
                                ${data.country || "India"}
                            </COUNTRY>

                            <CONTACTPERSON>
                                ${data.contact_person || ""}
                            </CONTACTPERSON>

                            <MOBILE>
                                ${data.mobile || ""}
                            </MOBILE>

                            <EMAIL>
                                ${data.email || ""}
                            </EMAIL>

                            <!-- IFSC -->

                            <IFSCCODE>
                                ${data.ifsc_code || ""}
                            </IFSCCODE>

                            <IFSCODE>
                                ${data.ifsc_code || ""}
                            </IFSCODE>

                        </LEDMAILINGDETAILS.LIST>

                        <!-- EXTRA DETAILS -->

                        <LEDSTATENAME>
                            ${data.state || ""}
                        </LEDSTATENAME>

                        <LEDCOUNTRYNAME>
                            ${data.country || "India"}
                        </LEDCOUNTRYNAME>

                        <LEDPINCODE>
                            ${data.pincode || ""}
                        </LEDPINCODE>

                        <LEDGERCONTACT>
                            ${data.contact_person || ""}
                        </LEDGERCONTACT>

                        <LEDGERPHONE>
                            ${data.mobile || ""}
                        </LEDGERPHONE>

                        <LEDGERMOBILE>
                            ${data.mobile || ""}
                        </LEDGERMOBILE>

                        <!-- BANK ACCOUNT DETAILS -->

                     <BANKALLOCATIONS.LIST>

    <!-- ACCOUNT HOLDER -->

    <BANKACCHOLDERNAME>
        ${data.account_holder || ""}
    </BANKACCHOLDERNAME>

    <!-- ACCOUNT NUMBER -->

 <BANKDETAILS>
    ${data.account_number || ""}
</BANKDETAILS>

    <!-- BANK< -->

   
<NAME>
    ${data.bank_name || ""}
</NAME>

<BANKNAME>
    ${data.bank_name || ""}
</BANKNAME>


    <BANKBRANCHNAME>
        ${data.branch_name || ""}
    </BANKBRANCHNAME>

    <BRANCHNAME>
        ${data.branch_name || ""}
    </BRANCHNAME>

    <!-- IFSC -->

    <BANKIFSC>
        ${data.ifsc_code || ""}
    </BANKIFSC>

    <IFSCCODE>
        ${data.ifsc_code || ""}
    </IFSCCODE>

    <IFSCODE>
        ${data.ifsc_code || ""}
    </IFSCODE>

    <!-- SWIFT -->

    <SWIFTCODE>
        ${data.swift_code || ""}
    </SWIFTCODE>

    <!-- IBAN -->

    <BANKIBAN>
        ${data.iban || ""}
    </BANKIBAN>

</BANKALLOCATIONS.LIST>

                        <!-- LANGUAGE -->

                        <LANGUAGENAME.LIST>

                            <NAME.LIST TYPE="String">

                                <NAME>
                                    ${data.ledger_name || ""}
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