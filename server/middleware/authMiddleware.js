const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/auth');

function cookieValue(req, name) {
  const cookie = req.headers.cookie || '';
  const prefix = `${encodeURIComponent(name)}=`;
  const part = cookie.split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
  return part ? decodeURIComponent(part.slice(prefix.length)) : '';
}

const protect = (req, res, next) => {
  let token;

  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : '';
  token = cookieValue(req, 'vividarts.customer.token') || bearer;

  if (token) {
    try {
      // Extract token from string
      // Verify token using secret key
      const decoded = jwt.verify(token, JWT_SECRET);

      // Attach decoded user data (id and role) to the request object
      req.user = decoded;

      // Move to the next middleware or route handler
      next();
    } catch (error) {
      return res.status(401).json({ message: 'Not authorized, token failed' });
    }
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token provided' });
  }
};

module.exports = { protect, cookieValue };
