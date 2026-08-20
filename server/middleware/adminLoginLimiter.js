const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const attempts = new Map();

function keyFor(req) {
  const username = String(req.body?.username || '').trim().toLowerCase();
  return `${req.ip}|${username}`;
}

function adminLoginLimiter(req, res, next) {
  const now = Date.now();
  const key = keyFor(req);
  const entry = attempts.get(key) || { failures: [], lockedUntil: 0 };
  entry.failures = entry.failures.filter(timestamp => now - timestamp < WINDOW_MS);
  if (entry.lockedUntil && entry.lockedUntil <= now) entry.lockedUntil = 0;

  if (entry.lockedUntil > now) {
    const retryAfter = Math.ceil((entry.lockedUntil - now) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
  }

  req.adminLoginAttempt = {
    failed() {
      entry.failures.push(Date.now());
      if (entry.failures.length >= MAX_FAILURES) {
        entry.lockedUntil = Date.now() + LOCK_MS;
        console.warn(`[security] Admin login temporarily locked for ${req.ip}`);
      }
      attempts.set(key, entry);
    },
    succeeded() { attempts.delete(key); },
  };
  next();
}

module.exports = adminLoginLimiter;
