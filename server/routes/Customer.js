const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Customer } = require('../models');
const { Op } = require('sequelize');
const { sendEmail } = require('../middleware/email');

const { uploadProfile, uploadCover, deleteImage } = require('../middleware/upload');

// 💡 Importing the Notification Model
const Notification = require('../models/Notification');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
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

router.get('/', async (req, res) => {
  const listOfCustomers = await Customer.findAll();
  res.json(listOfCustomers);
});

router.post('/', async (req, res) => {
  const customer = req.body;
  await Customer.create(customer);
  res.json(customer);
});

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

    if (delivery.skipped) {
      return res.status(503).json({ message: 'Email verification is not configured. Add SMTP settings to the backend .env file.' });
    }

    pendingEmailVerifications.set(email, {
      username,
      codeHash: hashOtp(email, code),
      expiresAt: Date.now() + OTP_LIFETIME_MS,
      attempts: 0,
    });
    res.json({ message: 'Verification code sent. Check your email.' });
  } catch (error) {
    res.status(500).json({ message: 'Unable to send the verification code. Please try again.' });
  }
});

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

router.post('/register', async (req, res) => {
  try {
    const { username, email, password, confirmPassword, verificationToken } = req.body;

    if (!username || !email || !password || !confirmPassword) {
      return res.status(400).json({ message: 'Username, email, password and confirmation are required.' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ message: 'Passwords do not match.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedUsername = username.trim();

    if (!normalizedUsername || !normalizedEmail) {
      return res.status(400).json({ message: 'Username and email cannot be blank.' });
    }

    if (password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long.' });
    }

    const verifiedEmail = verifiedEmailTokens.get(verificationToken);
    if (!verifiedEmail || verifiedEmail.expiresAt < Date.now() || verifiedEmail.email !== normalizedEmail || verifiedEmail.username !== normalizedUsername) {
      return res.status(403).json({ message: 'Please verify your email address before creating an account.' });
    }

    // Four rounds keep this classroom/local project responsive while passwords
    // are still stored as bcrypt hashes rather than plain text.
    const HASH_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS, 10) || 4;
    const hashedPassword = await bcrypt.hash(password, HASH_ROUNDS);

    // The database's unique username/email rules detect duplicate accounts.
    // Creating directly avoids an extra database lookup before every register.
    const newCustomer = await Customer.create({
      username: normalizedUsername,
      email: normalizedEmail,
      password_hash: hashedPassword,
      full_name: normalizedUsername,
      address: 'N/A',
      phone_number: 'N/A',
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

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: 'Username (or email) and password are required.' });
    }

    const identifier = username.trim();
    // Allow login by username or email. Emails are stored in lower case.
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
    res.status(500).json({ message: 'Login failed. Please try again.' });
  }
});

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

// POST /profile/avatar — upload or replace profile (avatar) image
router.post('/profile/avatar', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return res.status(401).json({ message: 'Authentication token missing.' });

    const decoded = decodeToken(token);
    if (!decoded || !decoded.customerId) return res.status(401).json({ message: 'Invalid authentication token.' });

    // Make the decoded id available to multer/cloudinary storage public_id generator
    req.decodedCustomerId = decoded.customerId;

    uploadProfile(req, res, async (err) => {
      if (err) return res.status(400).json({ message: err.message || 'Upload failed.' });
      if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });

      const customer = await Customer.findByPk(decoded.customerId);
      if (!customer) return res.status(404).json({ message: 'Customer not found.' });

      const previousPublicId = customer.profile_image_public_id;

      customer.profile_image_url = req.file.path;
      customer.profile_image_public_id = req.file.filename;
      await customer.save();

      // attempt to delete previous image (best-effort)
      try { if (previousPublicId && previousPublicId !== req.file.filename) await deleteImage(previousPublicId); } catch (e) { /* ignore */ }

      res.json({ message: 'Profile image updated.', profile_image_url: customer.profile_image_url });
    });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Unable to upload profile image.' });
  }
});

// POST /profile/cover — upload or replace cover image
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

    const { username, email } = req.body;
    if (username) customer.username = username;
    if (email) customer.email = email;

    await customer.save();

    res.json({
      message: 'Profile updated successfully.',
      customer: {
        customer_id: customer.customer_id,
        username: customer.username,
        email: customer.email,
        role: 'customer',
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Unable to update profile.' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS APIS (අලුතින් එකතු කළ කොටස)
// ════════════════════════════════════════════════════════════════════════════

// GET /notifications — Customer ගේ Notifications ලබා ගැනීම
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

    // Receiving the latest notifications related to the Customer ID
    const notifications = await Notification.find({ customerId: decoded.customerId }).sort({ createdAt: -1 });

    res.json({
      success: true,
      notifications,
    });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Failed to fetch notifications.' });
  }
});

// PUT /notifications/:id/read — Notification එක Read කළ බව Mark කිරීම
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

    await Notification.findByIdAndUpdate(req.params.id, { isRead: true });

    res.json({ success: true, message: 'Notification marked as read.' });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Failed to update notification status.' });
  }
});

module.exports = router;
