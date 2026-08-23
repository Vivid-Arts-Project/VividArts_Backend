const crypto = require('crypto');
const db = require('../models');

const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 3;
const requestTracker = new Map();

const hashOtp = (identifier, code) => crypto.createHash('sha256').update(`${identifier}:${code}`).digest('hex');

const getRecentRequestTimes = (identifier) => {
  const now = Date.now();
  const recent = requestTracker.get(identifier) || [];
  const filtered = recent.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW_MS);
  requestTracker.set(identifier, filtered);
  return filtered;
};

// Generate and save OTP with resend cooldown protection
const requestOTP = async (email, sendEmailFunction) => {
  const identifier = String(email || '').trim().toLowerCase();
  if (!identifier) {
    throw new Error('Email is required to request a verification code.');
  }

  const now = Date.now();
  const recentRequests = getRecentRequestTimes(identifier);
  if (recentRequests.length >= MAX_REQUESTS_PER_WINDOW) {
    throw new Error('Too many verification requests. Please wait before requesting a new code.');
  }

  let record = await db.VerificationToken.findOne({
    where: { identifier, type: 'register' },
  });

  if (record) {
    const lastResentAt = record.lastResentAt ? new Date(record.lastResentAt).getTime() : 0;
    const diffMs = now - lastResentAt;
    if (diffMs < RESEND_COOLDOWN_MS) {
      const waitTime = Math.ceil((RESEND_COOLDOWN_MS - diffMs) / 1000);
      throw new Error(`Please wait ${waitTime} seconds before requesting a new code.`);
    }
  }

  const otp = String(Math.floor(100000 + Math.random() * 900000)).padStart(6, '0');
  const otpHash = hashOtp(identifier, otp);
  const expiresAt = new Date(now + OTP_TTL_MS);

  if (record) {
    await record.update({
      otp: otpHash,
      attempts: 0,
      expiresAt,
      lastResentAt: new Date(now),
    });
  } else {
    await db.VerificationToken.create({
      identifier,
      otp: otpHash,
      type: 'register',
      attempts: 0,
      expiresAt,
      lastResentAt: new Date(now),
    });
  }

  let delivery;
  try {
    delivery = await sendEmailFunction(identifier, otp);
  } catch (error) {
    await db.VerificationToken.destroy({ where: { identifier, type: 'register' } });
    throw error;
  }
  if (delivery?.skipped) {
    await db.VerificationToken.destroy({ where: { identifier, type: 'register' } });
    throw new Error('Email verification is not configured. Please contact the administrator.');
  }
  recentRequests.push(now);
  requestTracker.set(identifier, recentRequests.slice(-MAX_REQUESTS_PER_WINDOW));
  return { message: 'OTP sent successfully', code: otp };
};

// Verify the submitted OTP with attempt limiting and expiry checks
const verifyOTP = async (email, enteredOtp) => {
  const identifier = String(email || '').trim().toLowerCase();
  const submittedOtp = String(enteredOtp || '').trim();

  const record = await db.VerificationToken.findOne({
    where: { identifier, type: 'register' },
  });

  if (!record) {
    throw new Error('No verification request found. Please request a new code.');
  }

  if (new Date() > new Date(record.expiresAt)) {
    await record.destroy();
    throw new Error('Verification code has expired. Please request a new one.');
  }

  if (Number(record.attempts || 0) >= MAX_ATTEMPTS) {
    await record.destroy();
    throw new Error('Too many incorrect attempts. Please request a new code.');
  }

  const submittedHash = hashOtp(identifier, submittedOtp);
  if (record.otp !== submittedHash) {
    const currentAttempts = Number(record.attempts || 0) + 1;
    await record.update({ attempts: currentAttempts });
    const remaining = MAX_ATTEMPTS - currentAttempts;
    throw new Error(`Invalid verification code. ${remaining > 0 ? `${remaining} attempts remaining.` : 'Please request a new code.'}`);
  }

  await record.destroy();
  return { success: true, message: 'Verification successful' };
};

module.exports = { requestOTP, verifyOTP, hashOtp, MAX_ATTEMPTS, OTP_TTL_MS, RESEND_COOLDOWN_MS, RATE_LIMIT_WINDOW_MS, MAX_REQUESTS_PER_WINDOW };
