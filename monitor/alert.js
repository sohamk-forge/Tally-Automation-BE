import nodemailer from "nodemailer";
import os from "os";
import { config } from "./config.js";
import { logEvent } from "./logger.js";

let transporter;
const tx = () =>
  (transporter ||= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 465,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    family: 4,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
  }));

export async function sendAlert(subject, lines) {
  if (!config.alertTo || !process.env.SMTP_HOST) {
    logEvent("warn", "alert", "SMTP/recipient not configured; alert not emailed", { subject });
    return false;
  }
  try {
    await tx().sendMail({
      from: `"${process.env.SMTP_FROM_NAME || "Tally Monitor"}" <${process.env.SMTP_USER}>`,
      to: config.alertTo,
      subject: `[Tally Monitor @ ${os.hostname()}] ${subject}`,
      text: lines.join("\n"),
    });
    logEvent("info", "alert", "alert emailed", { subject, to: config.alertTo });
    return true;
  } catch (e) {
    logEvent("error", "alert", `email failed: ${e.message}`, { subject });
    return false;
  }
}
