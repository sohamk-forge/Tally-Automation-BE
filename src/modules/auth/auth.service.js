const bcrypt = require('bcryptjs');
const { z } = require('zod');
const db = require('../../config/db');
const jwt = require('jsonwebtoken');
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
    phone: z.string().min(10).max(10),

    role: z.enum(['admin', 'owner', 'viewer']),
});

const register = async (data) => {
  // Validate input
  const validatedData = registerSchema.parse(data);

  const { email, password, phone ,role } = validatedData;

  // Check if user already exists
  const existingUser = await db('app.users')
    .where({ email })
    .first();

  if (existingUser) {
    throw new Error('User already exists');
  }

  // Hash password
  const hashedPassword = await bcrypt.hash(password, 10);

  // Save user
  const [user] = await db('app.users')
    .insert({
      email,
      password: hashedPassword,
      phone,
      role,
    })
    .returning(['id', 'email','phone' , 'role']);

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
  const user = await db('app.users')
    .where({ email })
    .first();

  if (!user) {
    throw new Error('Invalid email or password');
  }

  // Compare password
  const isPasswordValid = await bcrypt.compare(
    password,
    user.password
  );

  if (!isPasswordValid) {
    throw new Error('Invalid email or password');
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
      expiresIn: '1d',
    }
  );

  return {
    message: 'Login successful',
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
    message: 'Logout successful',
  };
};

module.exports = {
  register,
  login,
  logout,
};