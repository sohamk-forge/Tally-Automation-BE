import authService from "./auth.service.js";

const register = async (req, res) => {
  try {
    const user = await authService.register(req.body);

    return res.status(201).json({
      message: "User registered successfully",
      user,
    });
  } catch (error) {
    return res.status(400).json({
      error: error.message,
    });
  }
};

const login = async (req, res) => {
  try {
    const data = await authService.login(req.body);

    return res.status(200).json(data);
  } catch (error) {
    return res.status(400).json({
      error: error.message,
    });
  }
};

const me = async (req, res) => {
  try {
    return res.status(200).json(req.user);
  } catch (error) {
    return res.status(400).json({
      error: error.message,
    });
  }
};

const logout = async (req, res) => {
  try {
    const data = await authService.logout();

    return res.status(200).json(data);
  } catch (error) {
    return res.status(400).json({
      error: error.message,
    });
  }
};

export default {
  register,
  login,
  me,
  logout,
};