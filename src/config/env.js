export const PORT = process.env.PORT || 5001;

export const TALLY_URL =
  process.env.CONNECTOR_URL || "http://localhost:5002/api/connector/tally-request";