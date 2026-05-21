const express = require('express');
const router = express.Router();

const authController = require('./auth.controller');
const authMiddleware = require('../../middleware/auth.middleware');
router.post(
  '/logout',
  authMiddleware,
  authController.logout
);
router.get('/me', authMiddleware, authController.me);
router.post('/register', authController.register);
router.post('/login', authController.login);

module.exports = router;