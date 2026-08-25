const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/auth');
const { Customer } = require('../models');

function cookieValue(req, name) {
  const cookie = req.headers.cookie || '';
  const prefix = `${encodeURIComponent(name)}=`;
  const part = cookie.split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
  return part ? decodeURIComponent(part.slice(prefix.length)) : '';
}

function decodedTokenVersion(decoded) {
  return Number.isInteger(decoded?.tokenVersion) ? decoded.tokenVersion : 0;
}

function tokenVersionMatches(decoded, customer) {
  return decodedTokenVersion(decoded) === Number(customer?.token_version || 0);
}

const protect = async (req, res, next) => {
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : '';
  const token = cookieValue(req, 'vividarts.customer.token') || bearer;

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token provided' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ message: 'Not authorized, token failed' });
  }

  try {
    const customer = await Customer.findByPk(decoded.customerId, {
      attributes: ['customer_id', 'token_version'],
    });
    if (!customer || !tokenVersionMatches(decoded, customer)) {
      return res.status(401).json({ message: 'Your session has expired. Please sign in again.' });
    }
    req.user = { ...decoded, tokenVersion: decodedTokenVersion(decoded) };
    return next();
  } catch (error) {
    return next(error);
  }
};

module.exports = { protect, cookieValue, decodedTokenVersion, tokenVersionMatches };
