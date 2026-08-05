const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/auth');

const protect = (req, res, next) => {
  let token;

  // Check for token in the Authorization header (Format: Bearer <token>)
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      // Extract token from string
      token = req.headers.authorization.split(' ')[1];

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

module.exports = { protect };
