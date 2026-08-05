const isProduction = process.env.NODE_ENV === 'production';

const JWT_SECRET = process.env.JWT_SECRET || (isProduction ? null : 'dev-secret');

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET must be configured when NODE_ENV=production');
}

module.exports = { JWT_SECRET };
