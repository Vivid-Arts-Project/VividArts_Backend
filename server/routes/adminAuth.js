const express = require('express');
const router  = express.Router();
const db      = require('../models');
const { createAdminNotification } = require('../utils/adminNotificationHelper');
const { uploadProfile, uploadProfileImage, deleteImage } = require('../middleware/upload');
const adminLoginLimiter = require('../middleware/adminLoginLimiter');
const { sendEmail } = require('../middleware/email');

// ── POST /api/admin/register ──────────────────────────────────────────────────
// The first administrator bootstraps the system. Once one exists, only an
// authenticated administrator can create another account.
router.post('/register', async (req, res) => {
  try {
    const adminCount = await db.Admin.count();

    const { username, password, firstName, lastName, email, phone } = req.body;

    if (!username || !password || !email) {
      return res.status(400).json({ error: 'username, password and email are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = await db.Admin.findOne({ where: { [db.Sequelize.Op.or]: [{ username }, { email }] } });
    if (existing) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    const pending = await db.AdminRegistrationRequest.findOne({
      where: { status: 'pending', [db.Sequelize.Op.or]: [{ username }, { email }] },
    });
    if (pending) return res.status(409).json({ error: 'An administrator request is already pending for this username or email' });

    const passwordHash = await db.Admin.hashPassword(password);
    if (adminCount === 0) {
      const admin = await db.Admin.create({ username, passwordHash, firstName: firstName || '', lastName: lastName || '', email, phone: phone || null, isSuperAdmin: true });
      await regenerateSession(req);
      req.session.adminId = admin.id;
      await saveSession(req);
      return res.status(201).json({ message: 'Super administrator account created', admin: safeAdmin(admin), approved: true });
    }

    const request = await db.AdminRegistrationRequest.create({
      username: username.trim(), passwordHash, firstName: firstName || '', lastName: lastName || '',
      email: email.trim().toLowerCase(), phone: phone || null,
    });
    const superAdmins = await db.Admin.findAll({ where: { isSuperAdmin: true } });
    await Promise.all(superAdmins.map(async admin => {
      await createAdminNotification({
        adminId: admin.id, type: 'admin_request', title: 'New administrator request',
        message: `${request.firstName || request.username} (${request.email}) requested administrator access.`,
      });
      await sendEmail({
        to: admin.email, subject: 'New Vivid Arts administrator request',
        text: `${request.firstName || request.username} (${request.email}) requested administrator access. Sign in to review the request.`,
        html: `<p><strong>${request.firstName || request.username}</strong> (${request.email}) requested administrator access.</p><p>Sign in to Vivid Arts and open Settings → Admin Requests to approve or reject it.</p>`,
        metadata: { type: 'admin_registration_request', requestId: request.id },
      });
    }));
    res.status(202).json({ message: 'Your administrator request was submitted for approval.', requestId: request.id, approved: false });
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
    if (!admin || !admin.isActive || !(await admin.checkPassword(password))) {
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

router.get('/registration-requests', requireAdmin, async (req, res) => {
  const reviewer = await db.Admin.findByPk(req.session.adminId);
  if (!reviewer?.isSuperAdmin) return res.status(403).json({ error: 'Super administrator access is required' });
  const requests = await db.AdminRegistrationRequest.findAll({ order: [['createdAt', 'DESC']] });
  res.json(requests.map(item => {
    const { passwordHash, requestToken, ...safe } = item.toJSON();
    return safe;
  }));
});

router.get('/administrators', requireAdmin, async (req, res) => {
  const reviewer = await db.Admin.findByPk(req.session.adminId);
  if (!reviewer?.isSuperAdmin) return res.status(403).json({ error: 'Super administrator access is required' });
  const admins = await db.Admin.findAll({ order: [['isSuperAdmin', 'DESC'], ['createdAt', 'ASC']] });
  res.json(admins.map(safeAdmin));
});

router.patch('/administrators/:id/status', requireAdmin, async (req, res) => {
  const reviewer = await db.Admin.findByPk(req.session.adminId);
  if (!reviewer?.isSuperAdmin) return res.status(403).json({ error: 'Super administrator access is required' });
  const admin = await db.Admin.findByPk(req.params.id);
  if (!admin) return res.status(404).json({ error: 'Administrator not found' });
  if (admin.id === reviewer.id || admin.isSuperAdmin) return res.status(409).json({ error: 'The super administrator account cannot be disabled' });
  await admin.update({ isActive: req.body.isActive === true });
  if (!admin.isActive) await db.AdminSession.destroy({ where: { data: { [db.Sequelize.Op.like]: `%\"adminId\":\"${admin.id}\"%` } } });
  res.json({ message: `Administrator ${admin.isActive ? 'activated' : 'deactivated'}`, admin: safeAdmin(admin) });
});

router.delete('/administrators/:id', requireAdmin, async (req, res) => {
  const reviewer = await db.Admin.findByPk(req.session.adminId);
  if (!reviewer?.isSuperAdmin) return res.status(403).json({ error: 'Super administrator access is required' });
  const admin = await db.Admin.findByPk(req.params.id);
  if (!admin) return res.status(404).json({ error: 'Administrator not found' });
  if (admin.id === reviewer.id || admin.isSuperAdmin) return res.status(409).json({ error: 'The super administrator account cannot be removed' });
  await db.AdminSession.destroy({ where: { data: { [db.Sequelize.Op.like]: `%\"adminId\":\"${admin.id}\"%` } } });
  await admin.destroy();
  res.json({ message: 'Administrator account removed' });
});

router.patch('/registration-requests/:id', requireAdmin, async (req, res) => {
  const transaction = await db.sequelize.transaction();
  try {
    const reviewer = await db.Admin.findByPk(req.session.adminId, { transaction });
    if (!reviewer?.isSuperAdmin) {
      await transaction.rollback();
      return res.status(403).json({ error: 'Super administrator access is required' });
    }
    const decision = String(req.body.decision || '').toLowerCase();
    if (!['approved', 'rejected'].includes(decision)) {
      await transaction.rollback();
      return res.status(400).json({ error: 'Decision must be approved or rejected' });
    }
    const request = await db.AdminRegistrationRequest.findOne({ where: { id: req.params.id, status: 'pending' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!request) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Pending administrator request not found' });
    }
    let admin = null;
    if (decision === 'approved') {
      const duplicate = await db.Admin.findOne({ where: { [db.Sequelize.Op.or]: [{ username: request.username }, { email: request.email }] }, transaction });
      if (duplicate) throw new Error('An administrator already uses this username or email');
      admin = await db.Admin.create({
        username: request.username, passwordHash: request.passwordHash,
        firstName: request.firstName || '', lastName: request.lastName || '',
        email: request.email, phone: request.phone, isSuperAdmin: false,
      }, { transaction });
    }
    await request.update({ status: decision, decisionNote: String(req.body.note || '').trim() || null, reviewedBy: reviewer.id, reviewedAt: new Date() }, { transaction });
    await transaction.commit();
    await sendEmail({
      to: request.email,
      subject: `Your Vivid Arts administrator request was ${decision}`,
      text: decision === 'approved' ? 'Your administrator request was approved. You can now sign in using the username and password you supplied.' : `Your administrator request was rejected.${request.decisionNote ? ` Reason: ${request.decisionNote}` : ''}`,
      html: decision === 'approved' ? '<p>Your administrator request was approved. You can now sign in using the username and password you supplied.</p>' : `<p>Your administrator request was rejected.</p>${request.decisionNote ? `<p>Reason: ${request.decisionNote}</p>` : ''}`,
      metadata: { type: 'admin_registration_decision', requestId: request.id, decision },
    });
    res.json({ message: `Administrator request ${decision}`, admin: admin ? safeAdmin(admin) : null });
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    res.status(500).json({ error: error.message });
  }
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
