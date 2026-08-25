import nodemailer from "nodemailer";

let transporter = null;

const getTransporter = () => {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 465,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
    // This host can't route outbound IPv6 — without this, DNS sometimes
    // resolves smtp.gmail.com to an IPv6 address and the connection fails
    // with ENETUNREACH.
    family: 4,
    // Defaults are 2 minutes each — a transient network blip then hangs
    // the request for that long before finally failing. Fail fast instead
    // so the retry below actually gets a chance to run.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });

  return transporter;
};

// Error codes that mean "the connection/handshake itself failed" rather
// than "Gmail rejected the message" — worth retrying, since a one-off
// network blip on the next attempt usually succeeds.
const RETRYABLE_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETUNREACH",
  "ESOCKET",
  "EAI_AGAIN",
]);

const sendWithRetry = async (mailOptions, attempts = 3) => {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await getTransporter().sendMail(mailOptions);
    } catch (err) {
      const isLastAttempt = attempt === attempts;
      if (!RETRYABLE_CODES.has(err.code) || isLastAttempt) {
        throw err;
      }
      console.log(
        `SMTP send attempt ${attempt} failed (${err.code}), retrying...`
      );
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
};

export const sendInviteEmail = async (toEmail, inviteLink) => {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASSWORD) {
    console.log(`SMTP not configured — invite link for ${toEmail}: ${inviteLink}`);
    return;
  }

  await sendWithRetry({
    from: `"${process.env.SMTP_FROM_NAME || "Tally Automation"}" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: "You've been invited to join the team",
    html: `
      <p>You've been invited to join the team on Tally Automation.</p>
      <p><a href="${inviteLink}">Click here to accept the invite</a></p>
      <p>If the link doesn't work, copy and paste this URL into your browser:</p>
      <p>${inviteLink}</p>
    `,
  });
};
