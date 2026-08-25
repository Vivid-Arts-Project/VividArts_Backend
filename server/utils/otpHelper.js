const crypto = require('crypto');
const db = require('../models');

const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 3;

const hashOtp = (identifier, code) => crypto.createHash('sha256').update(`${identifier}:${code}`).digest('hex');

// Generate and save OTP with resend cooldown protection
const requestOTP = async (email, sendEmailFunction, type = 'register') => {
  const identifier = String(email || '').trim().toLowerCase();
  if (!identifier) {
    throw new Error('Email is required to request a verification code.');
  }

  const now = Date.now();
  const otp = String(crypto.randomInt(100000, 1000000));
  const otpHash = hashOtp(identifier, otp);
  const expiresAt = new Date(now + OTP_TTL_MS);
  const record = await db.sequelize.transaction(async transaction => {
    await db.VerificationToken.findOrCreate({
      where: { identifier, type },
      defaults: {
        otp: otpHash,
        attempts: 0,
        expiresAt,
        lastResentAt: null,
        requestWindowStartedAt: new Date(now),
        requestCount: 0,
      },
      transaction,
    });
    const lockedRecord = await db.VerificationToken.findOne({
      where: { identifier, type },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const lastResentAt = lockedRecord.lastResentAt ? new Date(lockedRecord.lastResentAt).getTime() : 0;
    const diffMs = now - lastResentAt;
    if (diffMs < RESEND_COOLDOWN_MS) {
      const waitTime = Math.ceil((RESEND_COOLDOWN_MS - diffMs) / 1000);
      throw new Error(`Please wait ${waitTime} seconds before requesting a new code.`);
    }
    const windowStartedAt = lockedRecord.requestWindowStartedAt
      ? new Date(lockedRecord.requestWindowStartedAt).getTime()
      : now;
    const windowActive = now - windowStartedAt < RATE_LIMIT_WINDOW_MS;
    const requestCount = windowActive ? Number(lockedRecord.requestCount || 0) : 0;
    if (requestCount >= MAX_REQUESTS_PER_WINDOW) {
      throw new Error('Too many verification requests. Please wait before requesting a new code.');
    }
    await lockedRecord.update({
      otp: otpHash,
      attempts: 0,
      expiresAt,
      lastResentAt: new Date(now),
      requestWindowStartedAt: new Date(windowActive ? windowStartedAt : now),
      requestCount: requestCount + 1,
    }, { transaction });
    return lockedRecord;
  });

  let delivery;
  try {
    delivery = await sendEmailFunction(identifier, otp);
  } catch (error) {
    await record.update({ otp: hashOtp(identifier, crypto.randomBytes(32).toString('hex')), expiresAt: new Date(0) });
    throw error;
  }
  if (delivery?.skipped) {
    await record.update({ otp: hashOtp(identifier, crypto.randomBytes(32).toString('hex')), expiresAt: new Date(0) });
    throw new Error('Email verification is not configured. Please contact the administrator.');
  }
  return { message: 'OTP sent successfully' };
};

// Verify the submitted OTP with attempt limiting and expiry checks
const verifyOTP = async (email, enteredOtp, type = 'register') => {
  const identifier = String(email || '').trim().toLowerCase();
  const submittedOtp = String(enteredOtp || '').trim();

  const record = await db.VerificationToken.findOne({
    where: { identifier, type },
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
