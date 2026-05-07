import "dotenv/config";

import app from "./app.js";

// import "./workers/syncWorker.js";

// import {
//   startScheduler
// } from "./jobs/syncScheduler.js";

const PORT =
  process.env.PORT || 5000;

app.listen(PORT, async () => {

  console.log(
    `Server running on ${PORT}`
  );

  // await startScheduler();

});