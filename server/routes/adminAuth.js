const express = require('express');
const router  = express.Router();
const db      = require('../models');
const { createAdminNotification } = require('../utils/adminNotificationHelper');
const { uploadProfile, uploadProfileImage, deleteImage } = require('../middleware/upload');
const adminLoginLimiter = require('../middleware/adminLoginLimiter');

// ── POST /api/admin/register ──────────────────────────────────────────────────
// The first administrator bootstraps the system. Once one exists, only an
// authenticated administrator can create another account.
router.post('/register', async (req, res) => {
  try {
    const adminCount = await db.Admin.count();
    if (adminCount > 0 && !req.session?.adminId) {
      return res.status(403).json({ error: 'Administrator registration requires an existing admin session' });
    }

    const { username, password, firstName, lastName, email, phone } = req.body;

    if (!username || !password || !email) {
      return res.status(400).json({ error: 'username, password and email are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = await db.Admin.findOne({ where: { username } });
    if (existing) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const emailUsed = await db.Admin.findOne({ where: { email } });
    if (emailUsed) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const admin = await db.Admin.create({
      username,
      passwordHash: await db.Admin.hashPassword(password),
      firstName:    firstName || '',
      lastName:     lastName  || '',
      email,
      phone:        phone || null,
    });

    // Rotate the session identifier before granting administrator access.
    await regenerateSession(req);
    req.session.adminId = admin.id;
    await saveSession(req);
    await createAdminNotification({
      adminId: admin.id,
      type: 'system',
      title: 'Account ready',
      message: `Administrator account created for ${admin.username}.`,
    });

    res.status(201).json({
      message: 'Admin account created',
      admin: safeAdmin(admin),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/login ─────────────────────────────────────────────────────
router.post('/login', adminLoginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    const admin = await db.Admin.findOne({ where: { username } });
    if (!admin || !(await admin.checkPassword(password))) {
      req.adminLoginAttempt.failed();
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    req.adminLoginAttempt.succeeded();
    await regenerateSession(req);
    req.session.adminId = admin.id;
    await saveSession(req);
    await createAdminNotification({
      adminId: admin.id,
      type: 'system',
      title: 'System ready',
      message: `Logged in as ${admin.username}.`,
    });
    res.json({ message: 'Logged in', admin: safeAdmin(admin) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/logout ────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('vividarts.admin.sid');
    res.json({ message: 'Logged out' });
  });
});

// ── GET /api/admin/me ─────────────────────────────────────────────────────────
// Called on page load — returns the logged-in admin's data so the
// frontend can show real details (name, businessName etc.) immediately.
// Returns 401 if no session → frontend redirects to /admin/login.
router.get('/me', async (req, res) => {
  if (!req.session?.adminId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const admin = await db.Admin.findByPk(req.session.adminId, {
      attributes: { exclude: ['passwordHash'] },
    });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });
    res.json(admin);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/profile ──────────────────────────────────────────────────
router.patch('/profile', requireAdmin, async (req, res) => {
  try {
    const admin = await db.Admin.findByPk(req.session.adminId);
    const { firstName, lastName, email, phone } = req.body;
    await admin.update({ firstName, lastName, email, phone });
    res.json({ message: 'Profile updated', admin: safeAdmin(admin) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/profile/image', requireAdmin, (req, res) => {
  uploadProfile(req, res, async uploadError => {
    if (uploadError) return res.status(400).json({ error: uploadError.message });
    if (!req.file) return res.status(400).json({ error: 'Select a JPG, PNG, or WebP image' });

    try {
      const admin = await db.Admin.findByPk(req.session.adminId);
      if (!admin) return res.status(404).json({ error: 'Admin not found' });
      const previousPublicId = admin.profileImagePublicId;
      const uploaded = await uploadProfileImage(req.file, `admin_${admin.id}`);
      await admin.update({
        profileImageUrl: uploaded.url,
        profileImagePublicId: uploaded.publicId,
      });
      if (previousPublicId) deleteImage(previousPublicId).catch(() => {});
      res.json({ message: 'Profile photo updated', admin: safeAdmin(admin) });
    } catch (error) {
      res.status(500).json({ error: error.message || 'Unable to update profile photo' });
    }
  });
});

// ── PATCH /api/admin/business ─────────────────────────────────────────────────
router.patch('/business', requireAdmin, async (req, res) => {
  try {
    const admin = await db.Admin.findByPk(req.session.adminId);
    const { businessName, businessEmail, businessAddress } = req.body;
    await admin.update({ businessName, businessEmail, businessAddress });
    res.json({ message: 'Business info updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH /api/admin/password ─────────────────────────────────────────────────
router.patch('/password', requireAdmin, async (req, res) => {
  try {
    const admin = await db.Admin.findByPk(req.session.adminId);
    const { currentPassword, newPassword } = req.body;
    if (!(await admin.checkPassword(currentPassword))) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    await admin.update({ passwordHash: await db.Admin.hashPassword(newPassword) });
    res.json({ message: 'Password updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── helpers ───────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.session?.adminId) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function safeAdmin(admin) {
  const { passwordHash, ...safe } = admin.toJSON();
  return safe;
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
}

function saveSession(req) {
  return new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
}

module.exports = router;
module.exports.requireAdmin = requireAdmin;
