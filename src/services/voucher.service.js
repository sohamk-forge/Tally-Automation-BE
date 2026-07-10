export function
buildVoucherJson(
  voucher
) {

  const amount =
  Number(
    voucher.amount
  );

  let ledgers =
  [];

  // PAYMENT
  if (
    voucher
    .voucher_type
    ===
    "payment"
  ) {

    ledgers = [

      {
        ledger_name:
        voucher
        .party_ledger,

        amount:
        -amount,

        is_positive:
        true
      },

      {
        ledger_name:
        voucher
        .bank_ledger,

        amount:
        amount,

        is_positive:
        false,

        bank_allocation:
        {

          bank_name:
          voucher
          .bank_ledger,

          party_name:
          voucher
          .party_ledger,

          instrument_number:
          voucher
          .instrument_number
          || ""
        }
      }
    ];
  }

  // RECEIPT
  if (
    voucher
    .voucher_type
    ===
    "receipt"
  ) {

    ledgers = [

      {
        ledger_name:
        voucher
        .party_ledger,

        amount:
        amount,

        is_positive:
        false
      },

      {
        ledger_name:
        voucher
        .bank_ledger,

        amount:
        -amount,

        is_positive:
        true,

        bank_allocation:
        {

          bank_name:
          voucher
          .bank_ledger,

          party_name:
          voucher
          .party_ledger,

          instrument_number:
          voucher
          .instrument_number
          || ""
        }
      }
    ];
  }

  // CONTRA
  if (
    voucher
    .voucher_type
    ===
    "contra"
  ) {

    ledgers = [

      {
        ledger_name:
        voucher
        .bank_ledger,

        amount:
        amount,

        is_positive:
        false
      },

      {
        ledger_name:
        voucher
        .transfer_bank,

        amount:
        -amount,

        is_positive:
        true
      }
    ];
  }

  return {

    company:
    voucher
    .company_name,

    voucher_type:
    voucher
    .voucher_type,

    voucher_number:
    voucher
    .voucher_number,

    date:
    voucher
    .voucher_date
    .toISOString()
    .split("T")[0]
    .replaceAll(
      "-",
      ""
    ),

    party_ledger:
    voucher
    .party_ledger,

    narration:
    voucher
    .narration,

    ledgers
  };
}