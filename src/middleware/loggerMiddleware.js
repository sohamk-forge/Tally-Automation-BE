import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
import { isQuietRoute } from "../utils/quietRoutes.js";

export async function loggerMiddleware(
  req,
  res,
  next
) {

  // Connector polling routes (/api/connector/jobs, /heartbeat) hit this on
  // every request from every connected device, every few seconds — full
  // audit_logs writes plus console output for each one is pure noise on
  // the routine case and grows the table for no real signal.
  if (isQuietRoute(req)) {
    return next();
  }

  /* =====================================
     START TIME
  ===================================== */

  const startTime =
    Date.now();

  /* =====================================
     ORIGINAL RESPONSE METHODS
  ===================================== */

  const originalJson =
    res.json;

  const originalSend =
    res.send;

  /* =====================================
     COMMON LOGGER FUNCTION
  ===================================== */

  const saveLog = async (
    responseBody = null
  ) => {

    try {

      /* ===================================
         RESPONSE TIME
      =================================== */

      const responseTime =
        Date.now() - startTime;

      /* ===================================
         REQUEST DETAILS
      =================================== */

      const company =
        req.query.company || null;

      const fromDate =
        req.query.fromDate || null;

      const toDate =
        req.query.toDate || null;

      /* ===================================
         LOG TYPE
      =================================== */

      const logType =

        res.statusCode >= 500
          ? "SERVER_ERROR"

          : res.statusCode >= 400
          ? "CLIENT_ERROR"

          : "SUCCESS";

      /* ===================================
         CLEAN RESPONSE BODY
      =================================== */

      let safeResponse =
        responseBody;

      if (
        typeof responseBody
        === "string"
      ) {

        try {

          safeResponse =
            JSON.parse(
              responseBody
            );

        } catch {

          safeResponse = {

            raw:
              responseBody

          };

        }

      }

      /* ===================================
         TRUNCATE LARGE RESPONSE BODIES
         (full ledger/voucher lists etc. can
         be megabytes — storing them in full
         on every request/poll bloats
         audit_logs and slows every insert
         and later query on that table)
      =================================== */

      const RESPONSE_BODY_LIMIT_BYTES =
        10 * 1024; // 10KB

      let safeResponseSize = 0;

      try {

        safeResponseSize =
          Buffer.byteLength(
            JSON.stringify(
              safeResponse ?? {}
            )
          );

      } catch {

        safeResponseSize = 0;

      }

      if (
        safeResponseSize
        > RESPONSE_BODY_LIMIT_BYTES
      ) {

        safeResponse = {

          truncated: true,

          original_size_bytes:
            safeResponseSize

        };

      }

      /* ===================================
         METADATA
      =================================== */

      const metadata = {

        company,

        fromDate,

        toDate,

        baseUrl:
          req.baseUrl,

        path:
          req.path,

        query:
          req.query,

        params:
          req.params,

        execution_time_ms:
          responseTime,

        timestamp:
          new Date()
            .toISOString()

      };

      /* ===================================
         INSERT LOG
      =================================== */

      await pool.query(

        `
        INSERT INTO app_test.audit_logs (

          action,
          entity,
          metadata,

          method,
          endpoint,
          status_code,
          log_type,

          ip_address,
          user_agent,

          response_time_ms,

          request_body,
          response_body,

          created_at

        )

        VALUES (

          $1,$2,$3,
          $4,$5,$6,$7,
          $8,$9,
          $10,
          $11,$12,
          NOW()

        )
        `,

        [

          "API_CALL",

          req.originalUrl,

          metadata,

          req.method,

          req.originalUrl,

          res.statusCode,

          logType,

          req.ip,

          req.headers[
            "user-agent"
          ] || null,

          responseTime,

          req.body || {},

          safeResponse || {}

        ]

      );

      /* ===================================
         CONSOLE LOG
      =================================== */

      console.log({

        method:
          req.method,

        endpoint:
          req.originalUrl,

        status:
          res.statusCode,

        responseTime,

        logType

      });

    } catch (err) {

      console.log(

        "LOGGER ERROR:",

        err.message

      );

    }

  };

  /* =====================================
     OVERRIDE res.json

     Send the response first, log after —
     the client should never wait on an
     audit_logs insert. saveLog already
     catches its own errors, so a failed
     write can't crash the request.
  ===================================== */

  res.json = function (
    body
  ) {

    const result =
      originalJson.call(
        this,
        body
      );

    saveLog(body);

    return result;

  };

  /* =====================================
     OVERRIDE res.send
  ===================================== */

  res.send = function (
    body
  ) {

    const result =
      originalSend.call(
        this,
        body
      );

    saveLog(body);

    return result;

  };

  /* =====================================
     REQUEST START LOG
  ===================================== */

  console.log({

    type: "REQUEST_START",

    method:
      req.method,

    endpoint:
      req.originalUrl,

    time:
      new Date()
        .toISOString()

  });

  next();

}