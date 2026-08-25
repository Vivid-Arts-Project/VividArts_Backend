const express = require('express');
const router  = express.Router();
const db      = require('../models');
const { createAdminNotification } = require('../utils/adminNotificationHelper');
const { uploadProfile, uploadProfileImage, deleteImage } = require('../middleware/upload');
const adminLoginLimiter = require('../middleware/adminLoginLimiter');
const adminRegistrationLimiter = require('../middleware/adminRegistrationLimiter');
const { sendEmail } = require('../middleware/email');
const bcrypt = require('bcrypt');

const escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

// ── POST /api/admin/register ──────────────────────────────────────────────────
// The first administrator bootstraps the system. Later public applications are
// stored as pending requests that require super-administrator approval.
router.post('/register', adminRegistrationLimiter, async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const firstName = String(req.body.firstName || '').trim();
    const lastName = String(req.body.lastName || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = String(req.body.phone || '').trim() || null;

    if (!username || !password || !email) {
      return res.status(400).json({ error: 'username, password and email are required' });
    }
    if (username.length > 50 || firstName.length > 80 || lastName.length > 80 || (phone && phone.length > 20)) {
      return res.status(400).json({ error: 'Administrator registration details are too long' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const passwordHash = await db.Admin.hashPassword(password);
    const registration = await db.sequelize.transaction(async transaction => {
      const bootstrapLock = await db.SiteSetting.findByPk(1, {
        attributes: ['id'],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!bootstrapLock) throw new Error('Administrator bootstrap lock is not initialized');

      const adminCount = await db.Admin.count({ transaction });
      const existing = await db.Admin.findOne({
        where: { [db.Sequelize.Op.or]: [{ username }, { email }] },
        transaction,
      });
      if (existing) throw Object.assign(new Error('Username or email is already registered'), { statusCode: 409 });
      const pending = await db.AdminRegistrationRequest.findOne({
        where: { status: 'pending', [db.Sequelize.Op.or]: [{ username }, { email }] },
        transaction,
      });
      if (pending) {
        throw Object.assign(new Error('An administrator request is already pending for this username or email'), { statusCode: 409 });
      }

      if (adminCount === 0) {
        const admin = await db.Admin.create({
          username, passwordHash, firstName, lastName, email, phone, isSuperAdmin: true,
        }, { transaction });
        return { approved: true, admin };
      }

      const request = await db.AdminRegistrationRequest.create({
        username, passwordHash, firstName, lastName, email, phone,
      }, { transaction });
      return { approved: false, request };
    });

    if (registration.approved) {
      const { admin } = registration;
      await regenerateSession(req);
      req.session.adminId = admin.id;
      await saveSession(req);
      return res.status(201).json({ message: 'Super administrator account created', admin: safeAdmin(admin), approved: true });
    }

    const { request } = registration;
    const superAdmins = await db.Admin.findAll({ where: { isSuperAdmin: true } });
    const deliveries = await Promise.allSettled(superAdmins.map(async admin => {
      await createAdminNotification({
        adminId: admin.id, type: 'admin_request', title: 'New administrator request',
        message: `${request.firstName || request.username} (${request.email}) requested administrator access.`,
      });
      await sendEmail({
        to: admin.email, subject: 'New Vivid Arts administrator request',
        text: `${request.firstName || request.username} (${request.email}) requested administrator access. Sign in to review the request.`,
        html: `<p><strong>${escapeHtml(request.firstName || request.username)}</strong> (${escapeHtml(request.email)}) requested administrator access.</p><p>Sign in to Vivid Arts and open Settings → Admin Requests to approve or reject it.</p>`,
        metadata: { type: 'admin_registration_request', requestId: request.id },
      });
    }));
    deliveries.filter(result => result.status === 'rejected').forEach(result => {
      console.error('[admin registration] Notification delivery failed:', result.reason?.message || result.reason);
    });
    res.status(202).json({ message: 'Your administrator request was submitted for approval.', requestId: request.id, requestToken: request.requestToken, approved: false });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'Username or email is already registered' });
    }
    if (err.name === 'SequelizeValidationError') {
      return res.status(400).json({ error: err.errors?.[0]?.message || 'Administrator registration details are invalid' });
    }
    res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : 'Unable to submit administrator registration',
    });
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
    if (!admin) {
      const request = await db.AdminRegistrationRequest.findOne({
        where: { username },
        order: [['createdAt', 'DESC']],
      });
      if (request && await bcrypt.compare(password, request.passwordHash)) {
        req.adminLoginAttempt.succeeded();
        return res.status(403).json({
          error: request.status === 'pending' ? 'Your administrator request is waiting for approval.' : 'Your administrator request was rejected.',
          code: request.status === 'pending' ? 'ADMIN_APPROVAL_PENDING' : 'ADMIN_REQUEST_REJECTED',
          requestToken: request.requestToken,
          status: request.status,
        });
      }
    }
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
    if (!admin?.isActive) {
      req.session.destroy(() => {});
      res.clearCookie('vividarts.admin.sid');
      return res.status(401).json({ error: 'Administrator session is no longer active' });
    }
    res.json(admin);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/profile ──────────────────────────────────────────────────
router.patch('/profile', requireAdmin, async (req, res) => {
  try {
    const admin = await db.Admin.findByPk(req.session.adminId);
    const firstName = String(req.body.firstName ?? admin.firstName ?? '').trim();
    const lastName = String(req.body.lastName ?? admin.lastName ?? '').trim();
    const phone = String(req.body.phone ?? admin.phone ?? '').trim() || null;
    if (req.body.email !== undefined && String(req.body.email).trim().toLowerCase() !== admin.email.toLowerCase()) {
      return res.status(400).json({ error: 'Administrator email cannot be changed without verification' });
    }
    if (firstName.length > 80 || lastName.length > 80 || (phone && phone.length > 20)) {
      return res.status(400).json({ error: 'Profile details are too long' });
    }
    await admin.update({ firstName, lastName, phone });
    res.json({ message: 'Profile updated', admin: safeAdmin(admin) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Public, token-scoped status used by the applicant waiting screen. The random
// token is the only lookup key and no password hash or contact details leave the API.
router.get('/registration-request-status/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{64}$/i.test(token)) return res.status(404).json({ error: 'Administrator request not found' });
    const request = await db.AdminRegistrationRequest.findOne({ where: { requestToken: token } });
    if (!request) return res.status(404).json({ error: 'Administrator request not found' });
    res.json({
      status: request.status,
      username: request.username,
      firstName: request.firstName || '',
      decisionNote: request.status === 'rejected' ? request.decisionNote : null,
      reviewedAt: request.reviewedAt,
    });
  } catch (error) {
    res.status(500).json({ error: 'Unable to check administrator request status' });
  }
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

    let uploaded = null;
    try {
      const admin = await db.Admin.findByPk(req.session.adminId);
      if (!admin) return res.status(404).json({ error: 'Admin not found' });
      const previousPublicId = admin.profileImagePublicId;
      uploaded = await uploadProfileImage(req.file, `admin_${admin.id}`);
      await admin.update({
        profileImageUrl: uploaded.url,
        profileImagePublicId: uploaded.publicId,
      });
      if (previousPublicId) deleteImage(previousPublicId).catch(() => {});
      res.json({ message: 'Profile photo updated', admin: safeAdmin(admin) });
    } catch (error) {
      if (uploaded?.publicId) await deleteImage(uploaded.publicId).catch(() => {});
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
    if (!admin) return res.status(404).json({ error: 'Administrator not found' });
    const { currentPassword, newPassword } = req.body;
    if (!(await admin.checkPassword(currentPassword))) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    await admin.update({ passwordHash: await db.Admin.hashPassword(newPassword) });
    const adminId = admin.id;
    await db.AdminSession.destroy({
      where: { data: { [db.Sequelize.Op.like]: `%\"adminId\":\"${adminId}\"%` } },
    });
    req.session.destroy(error => {
      if (error) return res.status(500).json({ error: 'Password changed, but sessions could not be cleared' });
      res.clearCookie('vividarts.admin.sid');
      return res.json({ message: 'Password updated. Please sign in again.' });
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── helpers ───────────────────────────────────────────────────────────────────
async function requireAdmin(req, res, next) {
  if (!req.session?.adminId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const admin = await db.Admin.findByPk(req.session.adminId, {
      attributes: ['id', 'isActive', 'isSuperAdmin'],
    });
    if (!admin?.isActive) {
      req.session.destroy(() => {});
      res.clearCookie('vividarts.admin.sid');
      return res.status(401).json({ error: 'Administrator session is no longer active' });
    }
    req.admin = admin;
    next();
  } catch (error) {
    next(error);
  }
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
