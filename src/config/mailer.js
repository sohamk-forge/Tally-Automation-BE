import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Verify connection on startup (same style as db.js connection check)
transporter
  .verify()
  .then(() => {
    console.log("✅ Email service connected successfully");
  })
  .catch((error) => {
    console.error("❌ Email service connection failed:", error.message);
  });

const sendVerificationEmail = async (toEmail, token) => {
  const verifyLink = `${process.env.FRONTEND_URL}/verify-email/confirm?token=${token}`;

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: toEmail,
    subject: "Verify your email — Sai Computech ERP",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #1d4ed8;">Verify your email</h2>
        <p>Thanks for signing up. Click the button below to complete your registration.</p>
        <a href="${verifyLink}"
           style="display: inline-block; background: #1d4ed8; color: #fff; padding: 12px 24px;
                  text-decoration: none; border-radius: 8px; margin: 16px 0;">
          Verify Email
        </a>
        <p style="color: #64748b; font-size: 13px;">
          This link will expire in 30 minutes. If you didn't request this, you can ignore this email.
        </p>
        <p style="color: #94a3b8; font-size: 12px;">
          Or copy this link: ${verifyLink}
        </p>
      </div>
    `,
  });
};

export { sendVerificationEmail };
export default transporter;