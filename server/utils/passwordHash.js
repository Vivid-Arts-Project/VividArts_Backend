const bcrypt = require('bcrypt');

const MIN_BCRYPT_ROUNDS = 12;
const MAX_BCRYPT_ROUNDS = 15;

function resolveBcryptRounds({
  nodeEnv = process.env.NODE_ENV || 'development',
  configuredRounds = process.env.BCRYPT_ROUNDS,
} = {}) {
  if (configuredRounds === undefined || configuredRounds === null || configuredRounds === '') {
    return MIN_BCRYPT_ROUNDS;
  }

  const rounds = Number(configuredRounds);
  if (!Number.isInteger(rounds) || rounds < 4 || rounds > MAX_BCRYPT_ROUNDS) {
    throw new Error(`BCRYPT_ROUNDS must be an integer between ${MIN_BCRYPT_ROUNDS} and ${MAX_BCRYPT_ROUNDS}`);
  }
  if (nodeEnv === 'production' && rounds < MIN_BCRYPT_ROUNDS) {
    throw new Error(`BCRYPT_ROUNDS must be at least ${MIN_BCRYPT_ROUNDS} in production`);
  }
  return Math.max(MIN_BCRYPT_ROUNDS, rounds);
}

const CUSTOMER_BCRYPT_ROUNDS = resolveBcryptRounds();

const hashCustomerPassword = password => bcrypt.hash(password, CUSTOMER_BCRYPT_ROUNDS);
const verifyCustomerPassword = (password, hash) => bcrypt.compare(password, hash);

function customerPasswordNeedsRehash(hash) {
  try {
    return bcrypt.getRounds(hash) < CUSTOMER_BCRYPT_ROUNDS;
  } catch {
    return true;
  }
}

module.exports = {
  MIN_BCRYPT_ROUNDS,
  MAX_BCRYPT_ROUNDS,
  CUSTOMER_BCRYPT_ROUNDS,
  resolveBcryptRounds,
  hashCustomerPassword,
  verifyCustomerPassword,
  customerPasswordNeedsRehash,
};
