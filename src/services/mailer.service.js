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
  });

  return transporter;
};

export const sendInviteEmail = async (toEmail, inviteLink) => {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASSWORD) {
    console.log(`SMTP not configured — invite link for ${toEmail}: ${inviteLink}`);
    return;
  }

  await getTransporter().sendMail({
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
