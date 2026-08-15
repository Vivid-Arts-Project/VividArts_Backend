const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Customer, Notification } = require('../models');
const { Op } = require('sequelize');
const { sendEmail } = require('../middleware/email');

const { uploadProfile, uploadProfileImage, uploadCover, deleteImage } = require('../middleware/upload');
const { JWT_SECRET } = require('../config/auth');

const OTP_LIFETIME_MS = 10 * 60 * 1000;
const pendingEmailVerifications = new Map();
const verifiedEmailTokens = new Map();

const hashOtp = (email, code) => crypto.createHash('sha256').update(`${email}:${code}`).digest('hex');

const createToken = (customer) => jwt.sign(
  { customerId: customer.customer_id, email: customer.email },
  JWT_SECRET,
  { expiresIn: '8h' }
);
const decodeToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
};

// 📧 1. SEND OTP TO EMAIL ROUTE
router.post('/register/send-otp', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();

    if (!username || !email) {
      return res.status(400).json({ message: 'Username and email are required.' });
    }

    const existingCustomer = await Customer.findOne({
      where: { [Op.or]: [{ username }, { email }] },
    });
    if (existingCustomer) {
      return res.status(409).json({ message: 'An account with this username or email already exists.' });
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const delivery = await sendEmail({
      to: email,
      subject: 'Your Vivid Arts verification code',
      text: `Your Vivid Arts verification code is ${code}. It expires in 10 minutes.`,
      html: `<p>Your Vivid Arts verification code is <strong style="font-size:20px;letter-spacing:3px">${code}</strong>.</p><p>This code expires in 10 minutes.</p>`,
    });

    const isDevelopment = process.env.NODE_ENV === 'development';
    if (delivery.skipped && !isDevelopment) {
      return res.status(503).json({ message: 'Email verification is not configured. Add SMTP settings to the backend .env file.' });
    }

    pendingEmailVerifications.set(email, {
      username,
      codeHash: hashOtp(email, code),
      expiresAt: Date.now() + OTP_LIFETIME_MS,
      attempts: 0,
    });
    if (delivery.skipped) {
      console.warn(`[auth] Development verification code for ${email}: ${code}`);
      return res.json({
        message: 'Development mode: use the verification code shown below.',
        developmentCode: code,
      });
    }

    res.json({ message: 'Verification code sent. Check your email.' });
  } catch (error) {
    res.status(500).json({ message: 'Unable to send the verification code. Please try again.' });
  }
});

// 🔑 2. VERIFY OTP CODE ROUTE
router.post('/register/verify-otp', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  const pending = pendingEmailVerifications.get(email);

  if (!pending || pending.expiresAt < Date.now()) {
    pendingEmailVerifications.delete(email);
    return res.status(400).json({ message: 'This verification code has expired. Please request a new one.' });
  }
  if (pending.attempts >= 5) {
    pendingEmailVerifications.delete(email);
    return res.status(429).json({ message: 'Too many incorrect attempts. Please request a new code.' });
  }
  if (pending.codeHash !== hashOtp(email, code)) {
    pending.attempts += 1;
    return res.status(400).json({ message: 'Incorrect verification code.' });
  }

  const verificationToken = crypto.randomBytes(32).toString('hex');
  verifiedEmailTokens.set(verificationToken, {
    username: pending.username,
    email,
    expiresAt: Date.now() + OTP_LIFETIME_MS,
  });
  pendingEmailVerifications.delete(email);
  res.json({ message: 'Email verified successfully.', verificationToken });
});

// ✅ 3. COMPLETE REGISTER ROUTE
router.post('/register', async (req, res) => {
  try {
    const { fullName, username, phoneNumber, email, password, confirmPassword, verificationToken } = req.body;

    if (!fullName || !username || !phoneNumber || !email || !password || !confirmPassword) {
      return res.status(400).json({ message: 'Full name, username, phone number, email, password and confirmation are required.' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ message: 'Passwords do not match.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedUsername = username.trim();
    const normalizedFullName = fullName.trim();
    const normalizedPhoneNumber = phoneNumber.trim();

    if (!normalizedFullName || !normalizedUsername || !normalizedPhoneNumber || !normalizedEmail) {
      return res.status(400).json({ message: 'Full name, username, phone number and email cannot be blank.' });
    }

    if (password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long.' });
    }

    const verifiedEmail = verifiedEmailTokens.get(verificationToken);
    if (!verifiedEmail || verifiedEmail.expiresAt < Date.now() || verifiedEmail.email !== normalizedEmail || verifiedEmail.username !== normalizedUsername) {
      return res.status(403).json({ message: 'Please verify your email address before creating an account.' });
    }

    const HASH_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS, 10) || 4;
    const hashedPassword = await bcrypt.hash(password, HASH_ROUNDS);

    const newCustomer = await Customer.create({
      username: normalizedUsername,
      email: normalizedEmail,
      password_hash: hashedPassword,
      full_name: normalizedFullName,
      address: 'N/A',
      phone_number: normalizedPhoneNumber,
    });
    verifiedEmailTokens.delete(verificationToken);

    res.status(201).json({
      message: 'Registration successful.',
      customerId: newCustomer.customer_id,
      customer: { username: newCustomer.username, email: newCustomer.email },
    });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ message: 'An account with this username or email already exists.' });
    }
    if (error.name === 'SequelizeValidationError') {
      return res.status(400).json({ message: error.errors[0]?.message || 'Please enter valid account details.' });
    }
    res.status(500).json({ message: 'Registration failed. Please try again.' });
  }
});

// 🔓 4. LOGIN ROUTE
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: 'Username (or email) and password are required.' });
    }

    const identifier = username.trim();
    const customer = await Customer.findOne({
      where: { [Op.or]: [{ username: identifier }, { email: identifier.toLowerCase() }] },
    });
    if (!customer) {
      return res.status(401).json({ message: 'Invalid username/email or password.' });
    }

    const passwordMatch = await bcrypt.compare(password, customer.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ message: 'Invalid username or password.' });
    }

    const token = createToken(customer);
    res.json({
      message: 'Login successful.',
      token,
      customer: {
        customer_id: customer.customer_id,
        username: customer.username,
        email: customer.email,
      },
    });
  } catch (error) {
    console.error('Customer login failed:', error);
    res.status(500).json({ message: 'Login failed. Please try again.' });
  }
});

// 👤 PROFILE ROUTES
router.get('/profile', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return res.status(401).json({ message: 'Authentication token missing.' });
    }

    const decoded = decodeToken(token);
    if (!decoded || !decoded.customerId) {
      return res.status(401).json({ message: 'Invalid authentication token.' });
    }

    const customer = await Customer.findByPk(decoded.customerId);
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found.' });
    }

    res.json({
      customer_id: customer.customer_id,
      username: customer.username,
      full_name: customer.full_name,
      email: customer.email,
      phone_number: customer.phone_number,
      address: customer.address,
      profile_image_url: customer.profile_image_url || null,
      cover_image_url: customer.cover_image_url || null,
      role: 'customer',
    });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Unable to load profile.' });
  }
});

router.post('/profile/avatar', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return res.status(401).json({ message: 'Authentication token missing.' });

    const decoded = decodeToken(token);
    if (!decoded || !decoded.customerId) return res.status(401).json({ message: 'Invalid authentication token.' });

    req.decodedCustomerId = decoded.customerId;

    uploadProfile(req, res, async (err) => {
      if (err) return res.status(400).json({ message: err.message || 'Upload failed.' });
      if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });

      const customer = await Customer.findByPk(decoded.customerId);
      if (!customer) return res.status(404).json({ message: 'Customer not found.' });

      const previousPublicId = customer.profile_image_public_id;
      const uploadedImage = await uploadProfileImage(req.file, customer.customer_id);

      customer.profile_image_url = uploadedImage.url;
      customer.profile_image_public_id = uploadedImage.publicId;
      await customer.save();

      try { if (previousPublicId && previousPublicId !== uploadedImage.publicId) await deleteImage(previousPublicId); } catch (e) { /* ignore */ }

      res.json({ message: 'Profile image updated.', profile_image_url: customer.profile_image_url });
    });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Unable to upload profile image.' });
  }
});

router.post('/profile/cover', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return res.status(401).json({ message: 'Authentication token missing.' });

    const decoded = decodeToken(token);
    if (!decoded || !decoded.customerId) return res.status(401).json({ message: 'Invalid authentication token.' });

    req.decodedCustomerId = decoded.customerId;

    uploadCover(req, res, async (err) => {
      if (err) return res.status(400).json({ message: err.message || 'Upload failed.' });
      if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });

      const customer = await Customer.findByPk(decoded.customerId);
      if (!customer) return res.status(404).json({ message: 'Customer not found.' });

      const previousPublicId = customer.cover_image_public_id;

      customer.cover_image_url = req.file.path;
      customer.cover_image_public_id = req.file.filename;
      await customer.save();

      try { if (previousPublicId && previousPublicId !== req.file.filename) await deleteImage(previousPublicId); } catch (e) { /* ignore */ }

      res.json({ message: 'Cover image updated.', cover_image_url: customer.cover_image_url });
    });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Unable to upload cover image.' });
  }
});

router.put('/profile', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return res.status(401).json({ message: 'Authentication token missing.' });
    }

    const decoded = decodeToken(token);
    if (!decoded || !decoded.customerId) {
      return res.status(401).json({ message: 'Invalid authentication token.' });
    }

    const customer = await Customer.findByPk(decoded.customerId);
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found.' });
    }

    const { fullName, username, phoneNumber, email } = req.body;
    if (fullName !== undefined) customer.full_name = String(fullName).trim();
    if (username) customer.username = username;
    if (phoneNumber !== undefined) customer.phone_number = String(phoneNumber).trim();
    if (email) customer.email = email;

    await customer.save();

    res.json({
      message: 'Profile updated successfully.',
      customer: {
        customer_id: customer.customer_id,
        full_name: customer.full_name,
        username: customer.username,
        phone_number: customer.phone_number,
        email: customer.email,
        role: 'customer',
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Unable to update profile.' });
  }
});

// 🔔 NOTIFICATIONS APIS
router.get('/notifications', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return res.status(401).json({ message: 'Authentication token missing.' });
    }

    const decoded = decodeToken(token);
    if (!decoded || !decoded.customerId) {
      return res.status(401).json({ message: 'Invalid authentication token.' });
    }

    const notifications = await Notification.findAll({
      where: { customerId: decoded.customerId },
      order: [['createdAt', 'DESC']]
    });

    res.json({
      success: true,
      notifications,
    });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Failed to fetch notifications.' });
  }
});

router.put('/notifications/:id/read', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return res.status(401).json({ message: 'Authentication token missing.' });
    }

    const decoded = decodeToken(token);
    if (!decoded || !decoded.customerId) {
      return res.status(401).json({ message: 'Invalid authentication token.' });
    }

    const updated = await Notification.update(
      { isRead: true },
      { where: { id: req.params.id, customerId: decoded.customerId } },
    );
    if (!updated[0]) return res.status(404).json({ message: 'Notification not found.' });

    res.json({ success: true, message: 'Notification marked as read.' });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Failed to update notification status.' });
  }
});

module.exports = router;
