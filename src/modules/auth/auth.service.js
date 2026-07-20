import bcrypt from "bcryptjs";
import { z } from "zod";
import pool from "../../db/index.js";
import jwt from "jsonwebtoken";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().min(10).max(10),
  role: z.enum([
    "admin",
    "owner",
    "viewer",
    "user"
  ]).optional(),
});

const register = async (data) => {
  // Validate input
  const validatedData = registerSchema.parse(data);

  const { email, password, phone, role } = validatedData;

  // Check if user already exists
 const existingUserResult = await pool.query(
  `
  SELECT id
  FROM app_test.users
  WHERE email = $1
  LIMIT 1
  `,
  [email]
);
  const existingUser = existingUserResult.rows[0];

  if (existingUser) {
    throw new Error("User already exists");
  }

  // Hash password
  const hashedPassword = await bcrypt.hash(password, 10);

  // Save user
  const insertResult = await pool.query(
    `
    INSERT INTO app_test.users
    (
      email,
      password,
      phone,
      role
    )
    VALUES
    (
      $1,
      $2,
      $3,
      $4
    )
    RETURNING
      id,
      email,
      phone,
      role,
      first_name,
      last_name,
      created_at,
      updated_at
    `,
    [
      email,
      hashedPassword,
      phone,
      role ?? "user"
    ]
  );

  const user = insertResult.rows[0];

  return user;
};

const login = async (data) => {
  // Validate input
  const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(6),
  });

  const validatedData = loginSchema.parse(data);

  const { email, password } = validatedData;

  // Find user by email
const userResult = await pool.query(
  `
  SELECT *
  FROM app_test.users
  WHERE email = $1
  LIMIT 1
  `,
  [email]
);
  const user = userResult.rows[0];

  if (!user) {
    throw new Error("Invalid email or password");
  }

  // Compare password
  const isPasswordValid = await bcrypt.compare(
    password,
    user.password
  );

  if (!isPasswordValid) {
    throw new Error("Invalid email or password");
  }

  // Generate JWT token
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

const logout = async () => {
  return {
    message: "Logout successful",
  };
};

export default {
  register,
  login,
  logout,
};