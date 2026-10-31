import cron from "node-cron";
import { refreshExpiringGstSessions } from "../services/gstAuth.service.js";

/* =====================================
   GST SESSION KEEP-ALIVE

   GSTN auth tokens last 6h and can be refreshed (without an OTP) shortly
   before they expire. The filing page used to do this from a browser timer,
   so closing the tab meant a new login OTP. This does it server-side: every
   5 minutes, refresh any session within 20 minutes of expiry.
   Set GST_AUTO_REFRESH=false to turn it off.
===================================== */

let running = false;

if (process.env.GST_AUTO_REFRESH !== "false") {
  cron.schedule("*/5 * * * *", async () => {
    if (running) return;
    running = true;
    try {
      const r = await refreshExpiringGstSessions();
      if (r.due > 0) console.log(`GST session keep-alive: ${r.refreshed}/${r.due} refreshed, ${r.expired} expired, ${r.failed} failed`);
    } catch (err) {
      console.log("GST SESSION KEEP-ALIVE FAILED:", err.message);
    } finally {
      running = false;
    }
  });

  console.log("GST Session Keep-Alive Cron Initialized");
}
