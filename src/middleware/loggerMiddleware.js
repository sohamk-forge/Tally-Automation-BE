import pool from "../db/index.js";

export async function loggerMiddleware(
  req,
  res,
  next
) {

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
        INSERT INTO app.audit_logs (

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
  ===================================== */

  res.json = async function (
    body
  ) {

    await saveLog(body);

    return originalJson.call(
      this,
      body
    );

  };

  /* =====================================
     OVERRIDE res.send
  ===================================== */

  res.send = async function (
    body
  ) {

    await saveLog(body);

    return originalSend.call(
      this,
      body
    );

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