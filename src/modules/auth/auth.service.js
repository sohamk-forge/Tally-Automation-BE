import bcrypt from "bcryptjs";
import { z } from "zod";
import db from "../../db.js";
import jwt from "jsonwebtoken";
import client from "../../config/twilio.js";
import { sendVerificationEmail } from "../../config/mailer.js";

// -------------------- Validation Schemas --------------------

const registerSchema = z.object({
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().length(10),
  role: z.enum(["admin", "owner", "viewer"]),
});

const sendOtpSchema = z.object({
  phone: z.string().length(10),
});

const verifyOtpSchema = z.object({
  phone: z.string().length(10),
  otp: z.string().length(6),
});

// -------------------- Register (Step 1: send verification email) --------------------

const register = async (data) => {
  const validatedData = registerSchema.parse(data);

const { email, password, phone, role } = validatedData;

  const existingUser = await db("app_test.users")
    .where({ email })
    .first();

  if (existingUser) {
    throw new Error("User already exists");
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  // Embed all registration data inside the token itself — nothing is saved to DB yet
const verificationToken = jwt.sign(
  {
    email,
    password: hashedPassword,
    phone,
    role,
  },
  process.env.EMAIL_VERIFICATION_SECRET,
  {
    expiresIn: "30m",
  }
);

  await sendVerificationEmail(email, verificationToken);

  return {
    message: "Verification email sent. Please check your inbox.",
    token: verificationToken, // returned so frontend can store it for "Resend" later
  };
};

// -------------------- Verify Email (Step 2: actually create the user) --------------------

const verifyEmail = async (data) => {
  const verifyEmailSchema = z.object({
    token: z.string().min(1),
  });

  const { token } = verifyEmailSchema.parse(data);

let payload;
try {
  payload = jwt.verify(token, process.env.EMAIL_VERIFICATION_SECRET);
} catch (error) {
  console.error("VERIFY EMAIL ERROR:", error.name, error.message); // 👈 added this line
  if (error.name === "TokenExpiredError") {
    throw new Error("Verification link has expired. Please register again.");
  }
  throw new Error("Invalid verification link.");
}

  const { first_name, last_name, email, password, phone, role } = payload;

  // Guard against race conditions (e.g. two tabs, double-click)
  const existingUser = await db("app_test.users")
    .where({ email })
    .first();

  if (existingUser) {
    throw new Error("This email is already verified. Please log in.");
  }

 const [user] = await db("app_test.users")
  .insert({
    email,
    password,
    phone,
    role,
  })
  .returning(["id", "email", "phone", "role"]);

  return {
    message: "Email verified successfully. You can now log in.",
    user,
  };
};

// -------------------- Resend Verification Email --------------------

const resendVerification = async (data) => {
  const resendSchema = z.object({
    token: z.string().min(1),
  });

  const { token } = resendSchema.parse(data);

  let payload;
  try {
    // ignoreExpiration: true — we still want the data even if the old link expired
    payload = jwt.verify(token, process.env.EMAIL_VERIFICATION_SECRET, {
      ignoreExpiration: true,
    });
  } catch (error) {
    throw new Error("Invalid verification session. Please register again.");
  }

  const { first_name, last_name, email, password, phone, role } = payload;

  const existingUser = await db("app_test.users")
    .where({ email })
    .first();

  if (existingUser) {
    throw new Error("This email is already verified. Please log in.");
  }

  const newToken = jwt.sign(
    { first_name, last_name, email, password, phone, role },
    process.env.EMAIL_VERIFICATION_SECRET,
    { expiresIn: "30m" }
  );

  await sendVerificationEmail(email, newToken);

  return {
    message: "Verification email resent. Please check your inbox.",
    token: newToken,
  };
};

// -------------------- Login --------------------

const login = async (data) => {
  const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(6),
  });

  const validatedData = loginSchema.parse(data);

  const { email, password } = validatedData;

  const user = await db("app_test.users")
    .where({ email })
    .first();

  if (!user) {
    throw new Error("Invalid email or password");
  }

  const isPasswordValid = await bcrypt.compare(
    password,
    user.password
  );

  if (!isPasswordValid) {
    throw new Error("Invalid email or password");
  }

  const token = jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "1d",
    }
  );

  return {
    message: "Login successful",
    token,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
    },
  };
};

// -------------------- Send OTP --------------------

const sendOtp = async (data) => {
  const validatedData = sendOtpSchema.parse(data);

  const { phone } = validatedData;

  const user = await db("app_test.users")
    .where({ phone })
    .first();

  if (!user) {
    throw new Error("User not found. Please register first.");
  }

  const verification = await client.verify.v2
    .services(process.env.TWILIO_VERIFY_SERVICE_SID)
    .verifications.create({
      to: `+91${phone}`,
      channel: "sms",
    });

  return {
    success: true,
    message: "OTP sent successfully",
    status: verification.status,
    sid: verification.sid,
  };
};

// -------------------- Verify OTP --------------------

const verifyOtp = async (data) => {
  const validatedData = verifyOtpSchema.parse(data);

  const { phone, otp } = validatedData;

  const verificationCheck = await client.verify.v2
    .services(process.env.TWILIO_VERIFY_SERVICE_SID)
    .verificationChecks.create({
      to: `+91${phone}`,
      code: otp,
    });

  if (verificationCheck.status !== "approved") {
    throw new Error("Invalid OTP");
  }

  const user = await db("app_test.users")
    .where({ phone })
    .first();

  if (!user) {
    throw new Error("User not found");
  }

  const token = jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "1d",
    }
  );

  return {
    success: true,
    message: "OTP verified successfully",
    token,
    user: {
      id: user.id,
      email: user.email,
      phone: user.phone,
      role: user.role,
    },
  };
};

// -------------------- Logout --------------------

const logout = async () => {
  return {
    message: "Logout successful",
  };
};

export default {
  register,
  verifyEmail,
  resendVerification,
  login,
  logout,
  sendOtp,
  verifyOtp,
};