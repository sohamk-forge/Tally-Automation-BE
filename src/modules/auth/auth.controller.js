import authService from "./auth.service.js";
import { ZodError } from "zod";

// -------------------- Register --------------------

const register = async (req, res) => {
  try {
    const data = await authService.register(req.body);

    return res.status(201).json(data);
  } catch (error) {
  console.error("REGISTER ERROR:", error);

  return res.status(400).json({
    message: error.message,
  });
}
};

// -------------------- Verify Email --------------------

const verifyEmail = async (req, res) => {
  try {
    console.log("VERIFY CALLED BY:", req.headers['user-agent'], req.ip);
    const data = await authService.verifyEmail(req.body);

    return res.status(200).json(data);
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).json({
        message: error.errors[0].message,
      });
    }

    return res.status(400).json({
      message: error.message,
    });
  }
};
// -------------------- Resend Verification --------------------

const resendVerification = async (req, res) => {
  try {
    const data = await authService.resendVerification(req.body);

    return res.status(200).json(data);
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).json({
        message: error.errors[0].message,
      });
    }

    return res.status(400).json({
      message: error.message,
    });
  }
};

// -------------------- Login --------------------

const login = async (req, res) => {
  try {
    const data = await authService.login(req.body);

    return res.status(200).json(data);
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).json({
        message: error.errors[0].message,
      });
    }

    return res.status(400).json({
      message: error.message,
    });
  }
};

// -------------------- Send OTP --------------------

const sendOtp = async (req, res) => {
  try {
    const data = await authService.sendOtp(req.body);

    return res.status(200).json(data);
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).json({
        message: error.errors[0].message,
      });
    }

    return res.status(400).json({
      message: error.message,
    });
  }
};

// -------------------- Verify OTP --------------------

const verifyOtp = async (req, res) => {
  try {
    const data = await authService.verifyOtp(req.body);

    return res.status(200).json(data);
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).json({
        message: error.errors[0].message,
      });
    }

    return res.status(400).json({
      message: error.message,
    });
  }
};

// -------------------- Current User --------------------

const me = async (req, res) => {
  try {
    return res.status(200).json(req.user);
  } catch (error) {
    return res.status(400).json({
      message: error.message,
    });
  }
};

// -------------------- Logout --------------------

const logout = async (req, res) => {
  try {
    const data = await authService.logout();

    return res.status(200).json(data);
  } catch (error) {
    return res.status(400).json({
      message: error.message,
    });
  }
};

export default {
  register,
  verifyEmail,
  resendVerification,
  login,
  me,
  logout,
  sendOtp,
  verifyOtp,
};