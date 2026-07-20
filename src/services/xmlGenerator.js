import { spawn } from "child_process";

export function generateXml(invoiceData) {
  return new Promise((resolve, reject) => {

    console.log("=================================");
    console.log("DATA SENT TO PYTHON");
    console.log(JSON.stringify(invoiceData, null, 2));
    console.log("=================================");

    const python = spawn(
      "python",
      ["src/python/generator.py"]
    );

    let stdout = "";
    let stderr = "";

    python.stdout.on("data", (data) => {
      stdout += data.toString("utf8");
    });

    python.stderr.on("data", (data) => {

      const msg = data.toString("utf8");

      console.log("=================================");
      console.log("PYTHON DEBUG");
      console.log(msg);
      console.log("=================================");

      stderr += msg;
    });

    python.on("close", (code) => {

      if (code !== 0) {
        return reject(
          new Error(
            stderr || `Python exited with code ${code}`
          )
        );
      }

      resolve(stdout);
    });

    python.on("error", (err) => {
      reject(err);
    });

    python.stdin.write(
      JSON.stringify(invoiceData)
    );

    python.stdin.end();
  });
}

export function generateSalesXml(invoiceData) {
  return new Promise((resolve, reject) => {

    console.log("=================================");
    console.log("DATA SENT TO PYTHON (SALES)");
    console.log(JSON.stringify(invoiceData, null, 2));
    console.log("=================================");

    const python = spawn(
      "python",
      ["src/python/sales_generator.py"]  // ✅ Sales Python file
    );

    let stdout = "";
    let stderr = "";

    python.stdout.on("data", (data) => {
      stdout += data.toString("utf8");
    });

    python.stderr.on("data", (data) => {
      const msg = data.toString("utf8");
      console.log("=================================");
      console.log("PYTHON DEBUG (SALES)");
      console.log(msg);
      console.log("=================================");
      stderr += msg;
    });

    python.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(stderr || `Python exited with code ${code}`)
        );
      }
      resolve(stdout);
    });

    python.on("error", (err) => {
      reject(err);
    });

    python.stdin.write(JSON.stringify(invoiceData));
    python.stdin.end();
  });
}