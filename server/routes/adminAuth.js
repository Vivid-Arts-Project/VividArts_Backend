const express = require('express');
const router = express.Router();
const db = require('../models');

router.post('/register', async (req, res) => {
  try {
    const { username, password, firstName, lastName, email, phone } = req.body;

    if (!username || !password || !email) {
      return res.status(400).json({ error: 'username, password and email are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = await db.Admin.findOne({ where: { username } });
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    const emailUsed = await db.Admin.findOne({ where: { email } });
    if (emailUsed) return res.status(409).json({ error: 'Email already registered' });

    const admin = await db.Admin.create({
      username,
      passwordHash: await db.Admin.hashPassword(password),
      firstName: firstName || '',
      lastName: lastName || '',
      email,
      phone: phone || null,
    });

    req.session.adminId = admin.id;
    res.status(201).json({ message: 'Admin account created', admin: safeAdmin(admin) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    const admin = await db.Admin.findOne({ where: { username } });
    if (!admin || !(await admin.checkPassword(password))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    req.session.adminId = admin.id;
    res.json({ message: 'Logged in', admin: safeAdmin(admin) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ message: 'Logged out' }));
});

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

router.get('/orders', requireAdmin, async (req, res) => {
  try {
    const orders = [];
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/customers', requireAdmin, async (req, res) => {
  try {
    const customers = await db.customers?.findAll?.({ attributes: ['id', 'fullName', 'email', 'phone'] }) || [];
    res.json(customers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function requireAdmin(req, res, next) {
  if (!req.session?.adminId) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function safeAdmin(admin) {
  const { passwordHash, ...safe } = admin.toJSON();
  return safe;
}

module.exports = router;
module.exports.requireAdmin = requireAdmin;