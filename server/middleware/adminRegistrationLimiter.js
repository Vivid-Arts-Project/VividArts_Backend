const WINDOW_MS = 60 * 60 * 1000;
const MAX_IP_REQUESTS = 8;
const MAX_IDENTITY_REQUESTS = 3;
const MAX_TRACKED_KEYS = 10_000;

function createAdminRegistrationLimiter({
  now = () => Date.now(),
  windowMs = WINDOW_MS,
  maxIpRequests = MAX_IP_REQUESTS,
  maxIdentityRequests = MAX_IDENTITY_REQUESTS,
  maxTrackedKeys = MAX_TRACKED_KEYS,
} = {}) {
  const ipRequests = new Map();
  const identityRequests = new Map();

  const recent = (map, key, timestamp) => {
    if (!key) return [];
    const values = (map.get(key) || []).filter(requestedAt => timestamp - requestedAt < windowMs);
    if (values.length) map.set(key, values);
    else map.delete(key);
    return values;
  };
  const bound = (map) => {
    while (map.size > maxTrackedKeys) map.delete(map.keys().next().value);
  };

  const limiter = function adminRegistrationLimiter(req, res, next) {
    const timestamp = now();
    const ip = String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 128);
    const username = String(req.body?.username || '').trim().toLowerCase().slice(0, 50);
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 254);
    const identityKeys = [username && `username:${username}`, email && `email:${email}`].filter(Boolean);
    const ipHistory = recent(ipRequests, ip, timestamp);
    const identityHistories = identityKeys.map(key => ({ key, history: recent(identityRequests, key, timestamp) }));
    const blockedHistories = [
      ...(ipHistory.length >= maxIpRequests ? [ipHistory] : []),
      ...identityHistories.filter(item => item.history.length >= maxIdentityRequests).map(item => item.history),
    ];
    if (blockedHistories.length) {
      const oldestRelevant = Math.min(...blockedHistories.map(history => history[0]));
      res.set('Retry-After', String(Math.max(1, Math.ceil((oldestRelevant + windowMs - timestamp) / 1000))));
      return res.status(429).json({ error: 'Too many administrator registration requests. Please try again later.' });
    }

    ipRequests.set(ip, [...ipHistory, timestamp]);
    for (const { key, history } of identityHistories) identityRequests.set(key, [...history, timestamp]);
    bound(ipRequests);
    bound(identityRequests);
    next();
  };

  limiter.trackedKeyCounts = () => ({ ips: ipRequests.size, identities: identityRequests.size });
  return limiter;
}

const adminRegistrationLimiter = createAdminRegistrationLimiter();
module.exports = adminRegistrationLimiter;
module.exports.createAdminRegistrationLimiter = createAdminRegistrationLimiter;
module.exports.constants = { WINDOW_MS, MAX_IP_REQUESTS, MAX_IDENTITY_REQUESTS, MAX_TRACKED_KEYS };
