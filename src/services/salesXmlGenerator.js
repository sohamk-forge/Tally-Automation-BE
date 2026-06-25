import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function generateSalesXml(invoiceData) {
  return new Promise((resolve, reject) => {

    console.log("=================================");
    console.log("DATA SENT TO PYTHON (SALES)");
    console.log(JSON.stringify(invoiceData, null, 2));
    console.log("=================================");

    const scriptPath = path.join(__dirname, "../python/sales_generator.py");

    const py = spawn("python", [scriptPath]);

    let stdout = "";
    let stderr = "";

    py.stdout.on("data", (data) => {
      stdout += data.toString("utf8");
    });

    py.stderr.on("data", (data) => {
      const msg = data.toString("utf8");
      console.log("=================================");
      console.log("PYTHON DEBUG (SALES)");
      console.log(msg);
      console.log("=================================");
      stderr += msg;
    });

    py.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(stderr || `sales_generator.py exited with code ${code}`));
      }
      resolve(stdout);
    });

    py.on("error", (err) => {
      reject(err);
    });

    py.stdin.write(JSON.stringify(invoiceData));
    py.stdin.end();
  });
}