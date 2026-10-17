#!/bin/bash
# Asks a running TallyPrime for licence values through $$LicenseInfo and prints one line per value.
# Usage:  ./scripts/tally-licence-probe.sh [tally_url]        (default http://127.0.0.1:9000)
# Parameter names come from the TDL reference manual for $$LicenseInfo (an older copy: check them on your Tally release).
# SerialNumber is confirmed on a real TallyPrime. IsLicensedMode / IsEducationalMode are the ones that say licensed or not.
# Run it once on a licensed Tally and, if you can, once in Educational mode, then compare the two outputs.
URL="${1:-http://127.0.0.1:9000}"
PARAMS="IsLicensedMode IsEducationalMode SerialNumber RemoteSerialNumber AccountID SiteID AdminEmailID IsAdmin IsIndian IsSilver IsGold LicServerDate LicServerTime LicServerDateTime"

for p in $PARAMS; do
  XML="<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>EXPORT</TALLYREQUEST><TYPE>FUNCTION</TYPE><ID>\$\$LicenseInfo</ID></HEADER><BODY><DESC><FUNCPARAMLIST><PARAM>$p</PARAM></FUNCPARAMLIST></DESC></BODY></ENVELOPE>"
  REPLY=$(curl -s -m 8 -X POST -H "Content-Type: text/xml" --data-binary "$XML" "$URL" | tr -d '\n\r')
  if [ -z "$REPLY" ]; then OUT="(no reply - is Tally's HTTP server on $URL?)"; else
    RESULT=$(echo "$REPLY" | sed -n 's:.*<RESULT[^>]*>\([^<]*\)</RESULT>.*:\1:p')
    TYPE=$(echo "$REPLY" | sed -n 's:.*<RESULT TYPE="\([^"]*\)".*:\1:p')
    ERR=$(echo "$REPLY" | sed -n 's:.*<LINEERROR>\([^<]*\)</LINEERROR>.*:\1:p')
    if [ -n "$RESULT" ]; then OUT="$RESULT  [$TYPE]"; elif [ -n "$ERR" ]; then OUT="ERROR: $ERR"; else OUT="(empty result)"; fi
  fi
  printf "%-20s %s\n" "$p" "$OUT"
done
