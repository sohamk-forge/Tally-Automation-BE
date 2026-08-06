import jwt from "jsonwebtoken";
import pool from "../db/index.js";

const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        error: "Access denied. No token provided",
      });
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        error: "Invalid token format",
      });
    }

    // Try as JWT first
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
      return next();
    } catch (err) {
      // Not a JWT, try as pairing token
    }

    // Try as pairing token
    const result = await pool.query(
      `
      SELECT user_id FROM app_test.connector_pairing_tokens
      WHERE token = $1 AND is_used = FALSE
      LIMIT 1
      `,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: "Invalid or expired token",
      });
    }

    req.user = { id: result.rows[0].user_id };
    next();

  } catch (error) {
    return res.status(401).json({
      error: "Invalid or expired token",
    });
  }
};

export default authMiddleware;