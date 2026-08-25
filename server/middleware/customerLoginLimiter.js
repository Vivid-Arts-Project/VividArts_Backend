const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_ACCOUNT_FAILURES = 10;
const MAX_IP_FAILURES = 30;
const MAX_TRACKED_KEYS = 10_000;

function createCustomerLoginLimiter({
  now = () => Date.now(),
  windowMs = WINDOW_MS,
  lockMs = LOCK_MS,
  maxAccountFailures = MAX_ACCOUNT_FAILURES,
  maxIpFailures = MAX_IP_FAILURES,
} = {}) {
  const accountAttempts = new Map();
  const ipAttempts = new Map();

  const pruneEntry = (map, key, timestamp) => {
    if (!key) return null;
    const entry = map.get(key) || { failures: [], lockedUntil: 0, lastSeenAt: timestamp };
    entry.failures = entry.failures.filter(failureAt => timestamp - failureAt < windowMs);
    if (entry.lockedUntil <= timestamp) entry.lockedUntil = 0;
    entry.lastSeenAt = timestamp;
    return entry;
  };

  const limitMapSize = (map, timestamp) => {
    if (map.size < MAX_TRACKED_KEYS) return;
    for (const [key, entry] of map) {
      if (entry.lockedUntil <= timestamp && timestamp - entry.lastSeenAt >= windowMs) map.delete(key);
    }
    while (map.size >= MAX_TRACKED_KEYS) map.delete(map.keys().next().value);
  };

  return function customerLoginLimiter(req, res, next) {
    const timestamp = now();
    const identifier = String(req.body?.username || '').trim().toLowerCase().slice(0, 254);
    const ip = String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 128);
    limitMapSize(accountAttempts, timestamp);
    limitMapSize(ipAttempts, timestamp);

    const accountEntry = pruneEntry(accountAttempts, identifier, timestamp);
    const ipEntry = pruneEntry(ipAttempts, ip, timestamp);
    const lockedUntil = Math.max(accountEntry?.lockedUntil || 0, ipEntry?.lockedUntil || 0);

    if (lockedUntil > timestamp) {
      res.set('Retry-After', String(Math.ceil((lockedUntil - timestamp) / 1000)));
      return res.status(429).json({ message: 'Too many login attempts. Please try again later.' });
    }

    req.customerLoginAttempt = {
      failed() {
        const failedAt = now();
        if (accountEntry) {
          accountEntry.failures.push(failedAt);
          if (accountEntry.failures.length >= maxAccountFailures) accountEntry.lockedUntil = failedAt + lockMs;
          accountEntry.lastSeenAt = failedAt;
          accountAttempts.set(identifier, accountEntry);
        }
        ipEntry.failures.push(failedAt);
        if (ipEntry.failures.length >= maxIpFailures) ipEntry.lockedUntil = failedAt + lockMs;
        ipEntry.lastSeenAt = failedAt;
        ipAttempts.set(ip, ipEntry);
      },
      succeeded() {
        if (identifier) accountAttempts.delete(identifier);
      },
    };

    next();
  };
}

const customerLoginLimiter = createCustomerLoginLimiter();

module.exports = customerLoginLimiter;
module.exports.createCustomerLoginLimiter = createCustomerLoginLimiter;
module.exports.constants = { WINDOW_MS, LOCK_MS, MAX_ACCOUNT_FAILURES, MAX_IP_FAILURES };
