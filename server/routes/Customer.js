const express = require('express');
const router = express.Router();
const { paginationFrom, paginationMeta } = require('../utils/pagination');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../models');
const { Customer, Notification, VerificationToken } = db;
const { Op } = require('sequelize');
const { sendEmailNow } = require('../middleware/email');
const { protect } = require('../middleware/authMiddleware');
const customerLoginLimiter = require('../middleware/customerLoginLimiter');
const verificationRequestLimiter = require('../middleware/verificationRequestLimiter');
const { requestOTP, verifyOTP, hashOtp } = require('../utils/otpHelper');
const {
  customerPasswordNeedsRehash,
  hashCustomerPassword,
  verifyCustomerPassword,
} = require('../utils/passwordHash');

const { uploadProfile, uploadProfileImage, uploadCover, deleteImage } = require('../middleware/upload');
const { JWT_SECRET } = require('../config/auth');
const { normalizeCustomerProfileUpdate } = require('../utils/customerProfileRules');

const OTP_LIFETIME_MS = 10 * 60 * 1000;

const createToken = (customer) => jwt.sign(
  {
    customerId: customer.customer_id,
    email: customer.email,
    tokenVersion: Number(customer.token_version || 0),
  },
  JWT_SECRET,
  { expiresIn: '8h' }
);
const customerCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 8 * 60 * 60 * 1000,
  path: '/',
};

// 📧 1. SEND OTP TO EMAIL ROUTE
router.post('/register/send-otp', verificationRequestLimiter, async (req, res) => {
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

    await requestOTP(email, async (recipient, code) => {
      const emailPayload = {
        to: recipient,
        subject: 'Your Vivid Arts verification code',
        text: `Your Vivid Arts verification code is ${code}. It expires in 10 minutes.`,
        html: `<p>Your Vivid Arts verification code is <strong style="font-size:20px;letter-spacing:3px">${code}</strong>.</p><p>This code expires in 10 minutes.</p>`,
      };
      return sendEmailNow(emailPayload);
    });

    res.json({ message: 'Verification code sent. Check your email.' });
  } catch (error) {
    console.error('[registration OTP] Email delivery failed:', error.code || error.message);
    const message = error?.message || 'Unable to send the verification code. Please try again.';
    if (message.includes('Too many verification requests') || message.includes('Please wait')) {
      return res.status(429).json({ message });
    }
    res.status(503).json({
      publicMessage: 'Email delivery is unavailable. Please check the studio email configuration and try again.',
      message: 'Unable to deliver the verification email.',
    });
  }
});

// 🔑 2. VERIFY OTP CODE ROUTE
router.post('/register/verify-otp', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();
    const username = String(req.body.username || '').trim();
    if (!email || !code || !username) {
      return res.status(400).json({ message: 'Email, username and verification code are required.' });
    }

    const result = await verifyOTP(email, code);
    const verificationToken = crypto.randomBytes(32).toString('hex');
    await VerificationToken.upsert({
      identifier: email,
      type: 'registration_verified',
      otp: hashOtp(email, verificationToken),
      attempts: 0,
      expiresAt: new Date(Date.now() + OTP_LIFETIME_MS),
      lastResentAt: null,
      requestWindowStartedAt: null,
      requestCount: 0,
      context: { username },
    });

    res.json({ message: result.message, verificationToken });
  } catch (error) {
    const message = error?.message || 'Incorrect verification code.';
    if (message.includes('expired') || message.includes('No verification request')) {
      return res.status(400).json({ message });
    }
    if (message.includes('Too many incorrect') || message.includes('Please request a new code.')) {
      return res.status(429).json({ message });
    }
    res.status(400).json({ message });
  }
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

    const hashedPassword = await hashCustomerPassword(password);
    const newCustomer = await db.sequelize.transaction(async transaction => {
      const verifiedEmail = await VerificationToken.findOne({
        where: { identifier: normalizedEmail, type: 'registration_verified' },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const isVerified = verifiedEmail
        && new Date(verifiedEmail.expiresAt).getTime() >= Date.now()
        && verifiedEmail.otp === hashOtp(normalizedEmail, verificationToken)
        && verifiedEmail.context?.username === normalizedUsername;
      if (!isVerified) {
        throw Object.assign(new Error('Please verify your email address before creating an account.'), { statusCode: 403 });
      }
      const customer = await Customer.create({
        username: normalizedUsername,
        email: normalizedEmail,
        password_hash: hashedPassword,
        full_name: normalizedFullName,
        address: 'N/A',
        phone_number: normalizedPhoneNumber,
      }, { transaction });
      await verifiedEmail.destroy({ transaction });
      return customer;
    });

    res.status(201).json({
      message: 'Registration successful.',
      customerId: newCustomer.customer_id,
      customer: { username: newCustomer.username, email: newCustomer.email },
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
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
router.post('/login', customerLoginLimiter, async (req, res) => {
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
      req.customerLoginAttempt.failed();
      return res.status(401).json({ message: 'Invalid username/email or password.' });
    }

    const passwordMatch = await verifyCustomerPassword(password, customer.password_hash);
    if (!passwordMatch) {
      req.customerLoginAttempt.failed();
      return res.status(401).json({ message: 'Invalid username/email or password.' });
    }

    req.customerLoginAttempt.succeeded();
    if (customerPasswordNeedsRehash(customer.password_hash)) {
      try {
        await customer.update({ password_hash: await hashCustomerPassword(password) });
      } catch (rehashError) {
        console.error('[security] Unable to upgrade customer password hash:', rehashError.message);
      }
    }

    const token = createToken(customer);
    res.cookie('vividarts.customer.token', token, customerCookieOptions);
    res.json({
      message: 'Login successful.',
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

router.post('/logout', (_req, res) => {
  res.clearCookie('vividarts.customer.token', {
    httpOnly: true,
    secure: customerCookieOptions.secure,
    sameSite: customerCookieOptions.sameSite,
    path: '/',
  });
  res.json({ message: 'Logged out.' });
});

router.post('/forgot-password/send-otp', verificationRequestLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ message: 'Email is required.' });
  try {
    const customer = await Customer.findOne({ where: { email } });
    if (customer) {
      await requestOTP(email, (recipient, code) => sendEmailNow({
        to: recipient,
        subject: 'Reset your Vivid Arts password',
        text: `Your Vivid Arts password reset code is ${code}. It expires in 10 minutes.`,
        html: `<p>Your Vivid Arts password reset code is <strong style="font-size:20px;letter-spacing:3px">${code}</strong>.</p><p>This code expires in 10 minutes. If you did not request this, you can ignore this email.</p>`,
      }), 'password_reset');
    }
    res.json({ message: 'If an account uses that email, a verification code has been sent.' });
  } catch (error) {
    const message = error?.message || '';
    if (message.includes('Too many verification requests') || message.includes('Please wait')) {
      return res.status(429).json({ message });
    }
    console.error('[password reset OTP] Email delivery failed:', error.code || error.message);
    res.status(503).json({ message: 'Unable to deliver the verification email. Please try again later.' });
  }
});

router.post('/forgot-password/reset', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  const { newPassword, confirmPassword } = req.body;
  if (!email || !code || !newPassword || !confirmPassword) return res.status(400).json({ message: 'Email, verification code, and both password fields are required.' });
  if (newPassword !== confirmPassword) return res.status(400).json({ message: 'Passwords do not match.' });
  if (newPassword.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters long.' });
  try {
    const customer = await Customer.findOne({ where: { email } });
    if (!customer) return res.status(400).json({ message: 'Invalid or expired verification request.' });
    await verifyOTP(email, code, 'password_reset');
    await customer.update({
      password_hash: await hashCustomerPassword(newPassword),
      token_version: Number(customer.token_version || 0) + 1,
    });
    res.clearCookie('vividarts.customer.token', { httpOnly: true, secure: customerCookieOptions.secure, sameSite: customerCookieOptions.sameSite, path: '/' });
    res.json({ message: 'Password reset successfully. You can now sign in.' });
  } catch (error) {
    res.status(400).json({ message: error?.message || 'Unable to reset password.' });
  }
});

// 👤 PROFILE ROUTES
router.get('/profile', protect, async (req, res) => {
  try {
    const customer = await Customer.findByPk(req.user.customerId);
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

router.post('/profile/avatar', protect, async (req, res) => {
  try {
    req.decodedCustomerId = req.user.customerId;

    uploadProfile(req, res, async (err) => {
      if (err) return res.status(400).json({ message: err.message || 'Upload failed.' });
      if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });
      let uploadedImage = null;
      try {
        const customer = await Customer.findByPk(req.user.customerId);
        if (!customer) return res.status(404).json({ message: 'Customer not found.' });

        const previousPublicId = customer.profile_image_public_id;
        uploadedImage = await uploadProfileImage(req.file, customer.customer_id);

        customer.profile_image_url = uploadedImage.url;
        customer.profile_image_public_id = uploadedImage.publicId;
        await customer.save();

        try { if (previousPublicId && previousPublicId !== uploadedImage.publicId) await deleteImage(previousPublicId); } catch (e) { /* ignore */ }

        return res.json({ message: 'Profile image updated.', profile_image_url: customer.profile_image_url });
      } catch (uploadError) {
        if (uploadedImage?.publicId) await deleteImage(uploadedImage.publicId).catch(() => {});
        return res.status(uploadError.statusCode || 502).json({ message: uploadError.statusCode ? uploadError.message : 'Unable to store profile image.' });
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Unable to upload profile image.' });
  }
});

router.post('/profile/cover', protect, async (req, res) => {
  try {
    req.decodedCustomerId = req.user.customerId;

    uploadCover(req, res, async (err) => {
      if (err) return res.status(400).json({ message: err.message || 'Upload failed.' });
      if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });

      try {
        const customer = await Customer.findByPk(req.user.customerId);
        if (!customer) {
          await deleteImage(req.file.filename).catch(() => {});
          return res.status(404).json({ message: 'Customer not found.' });
        }

        const previousPublicId = customer.cover_image_public_id;
        customer.cover_image_url = req.file.path;
        customer.cover_image_public_id = req.file.filename;
        await customer.save();

        try { if (previousPublicId && previousPublicId !== req.file.filename) await deleteImage(previousPublicId); } catch (e) { /* ignore */ }
        res.json({ message: 'Cover image updated.', cover_image_url: customer.cover_image_url });
      } catch (uploadError) {
        await deleteImage(req.file.filename).catch(() => {});
        res.status(500).json({ message: 'Unable to update cover image.' });
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Unable to upload cover image.' });
  }
});

router.put('/profile', protect, async (req, res) => {
  try {
    const customer = await Customer.findByPk(req.user.customerId);
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found.' });
    }

    await customer.update(normalizeCustomerProfileUpdate(req.body, customer));

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
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message, code: error.code });
    if (error.name === 'SequelizeValidationError') return res.status(400).json({ message: error.errors[0]?.message || 'Invalid profile details.' });
    res.status(500).json({ message: 'Unable to update profile.' });
  }
});

router.patch('/password', protect, async (req, res) => {
  try {
    const customer = await Customer.findByPk(req.user.customerId);
    if (!customer) return res.status(404).json({ message: 'Customer not found.' });
    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (!currentPassword || !newPassword || !confirmPassword) return res.status(400).json({ message: 'All password fields are required.' });
    if (newPassword !== confirmPassword) return res.status(400).json({ message: 'New passwords do not match.' });
    if (newPassword.length < 8) return res.status(400).json({ message: 'New password must be at least 8 characters long.' });
    if (!(await verifyCustomerPassword(currentPassword, customer.password_hash))) return res.status(400).json({ message: 'Current password is incorrect.' });
    await customer.update({
      password_hash: await hashCustomerPassword(newPassword),
      token_version: Number(customer.token_version || 0) + 1,
    });
    res.clearCookie('vividarts.customer.token', { httpOnly: true, secure: customerCookieOptions.secure, sameSite: customerCookieOptions.sameSite, path: '/' });
    res.json({ message: 'Password updated successfully. Please sign in again.' });
  } catch (error) {
    res.status(500).json({ message: 'Unable to update password. Please try again.' });
  }
});



module.exports = router;
