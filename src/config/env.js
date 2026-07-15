export const PORT = process.env.PORT || 5000;

export const TALLY_URL =
  process.env.CONNECTOR_URL || "http://localhost:5001/api/connector/tally-request";