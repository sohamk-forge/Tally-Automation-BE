/* ==================================================
   CREATE LEDGER XML
================================================== */

export const createLedgerXML = (data) => {

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

<SVCURRENTCOMPANY>
${data.company}
</SVCURRENTCOMPANY>

</STATICVARIABLES>

</REQUESTDESC>

<REQUESTDATA>

<TALLYMESSAGE xmlns:UDF="TallyUDF">

<LEDGER
NAME="${data.ledger_name}"
RESERVEDNAME=""
ACTION="Create"
>

<!-- BASIC DETAILS -->

<NAME>
${data.ledger_name}
</NAME>

<MAILINGNAME>
${data.ledger_name}
</MAILINGNAME>

<PARENT>
${data.parent}
</PARENT>

<OPENINGBALANCE>
${data.opening_balance || 0}
</OPENINGBALANCE>

<ISBILLWISEON>
${data.bill_wise || "Yes"}
</ISBILLWISEON>

<!-- MAILING DETAILS -->

<LEDMAILINGDETAILS.LIST>

<ADDRESS.LIST TYPE="String">

<ADDRESS>
${data.address || ""}
</ADDRESS>

</ADDRESS.LIST>

<APPLICABLEFROM>
20250401
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

</LEDMAILINGDETAILS.LIST>

<!-- EXTRA CONTACT DETAILS -->

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
${data.phone || ""}
</LEDGERPHONE>

<LEDGERMOBILE>
${data.mobile || ""}
</LEDGERMOBILE>

<EMAIL>
${data.email || ""}
</EMAIL>

<LEDGERWEBSITE>
${data.website || ""}
</LEDGERWEBSITE>

<!-- PAN DETAILS -->

<INCOMETAXNUMBER>
${data.pan || ""}
</INCOMETAXNUMBER>

<!-- GST -->

<ISGSTAPPLICABLE>
Yes
</ISGSTAPPLICABLE>

<GSTREGISTRATIONTYPE>
${data.gst_registration_type || "Regular"}
</GSTREGISTRATIONTYPE>

<PARTYGSTIN>
${data.gstin || ""}
</PARTYGSTIN>

<PLACEOFSUPPLY>
${data.state || ""}
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
${data.gst_registration_type || "Regular"}
</GSTREGISTRATIONTYPE>

<PARTYGSTIN>
${data.gstin || ""}
</PARTYGSTIN>

<STATE>
${data.state || ""}
</STATE>

</GSTDETAILS.LIST>

<!-- GST REGISTRATION DETAILS -->

<LEDGSTREGDETAILS.LIST>

<APPLICABLEFROM>
20250401
</APPLICABLEFROM>

<GSTREGISTRATIONTYPE>
${data.gst_registration_type || "Regular"}
</GSTREGISTRATIONTYPE>

<GSTIN>
${data.gstin || ""}
</GSTIN>

<STATE>
${data.state || ""}
</STATE>

</LEDGSTREGDETAILS.LIST>

<!-- LANGUAGE DETAILS -->

<LANGUAGENAME.LIST>

<NAME.LIST TYPE="String">

<NAME>
${data.ledger_name}
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