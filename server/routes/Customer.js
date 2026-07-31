const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { Customer } = require('../models');

const createToken = (customer) => Buffer.from(`${customer.customer_id}:${customer.email}`).toString('base64');
const decodeToken = (token) => {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const [customerId, email] = decoded.split(':');
    return { customerId: Number(customerId), email };
  } catch (error) {
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

router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ message: 'Username, email and password are required.' });
    }

    const existingCustomer = await Customer.findOne({ where: { email } });
    if (existingCustomer) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newCustomer = await Customer.create({
      username,
      email,
      password_hash: hashedPassword,
      full_name: username,
      address: 'N/A',
      phone_number: 'N/A',
      created_at: new Date(),
    });

    res.status(201).json({
      message: 'Registration successful.',
      customerId: newCustomer.customer_id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Registration failed.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required.' });
    }

    const customer = await Customer.findOne({ where: { username } });
    if (!customer) {
      return res.status(401).json({ message: 'Invalid username or password.' });
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
    res.status(500).json({ message: error.message || 'Login failed.' });
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
      email: customer.email,
      role: 'customer',
    });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Unable to load profile.' });
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

module.exports = router;