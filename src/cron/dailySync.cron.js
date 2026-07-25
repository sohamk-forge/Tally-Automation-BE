import cron from "node-cron";

import axios from "axios";

/* =====================================
   DAILY AUTO JOB CREATION
===================================== */

cron.schedule(

  "0 0 * * *",

  async () => {

    try {

      console.log("\n");

      console.log(
        "====================================="
      );

      console.log(
        "DAILY AUTO SYNC STARTED"
      );

      console.log(
        "====================================="
      );

      /* =================================
         CREATE JOBS ONLY
      ================================= */

      const response =

        await axios.post(

          `http://localhost:${process.env.PORT || 5001}/api/sync/manual`

        );

      console.log(
        "Jobs Created Successfully"
      );

      console.log(
        response.data
      );

      console.log(
        "====================================="
      );

    } catch (err) {

      console.log(
        "DAILY AUTO SYNC FAILED"
      );

      console.log(
        err.message
      );

    }

  }

);

console.log(
  "Daily Sync Cron Initialized"
);