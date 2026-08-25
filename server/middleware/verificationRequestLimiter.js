const WINDOW_MS = 60 * 60 * 1000;
const MAX_IP_REQUESTS = 12;
const MAX_TRACKED_IPS = 10_000;

function createVerificationRequestLimiter({
  now = () => Date.now(),
  windowMs = WINDOW_MS,
  maxIpRequests = MAX_IP_REQUESTS,
  maxTrackedIps = MAX_TRACKED_IPS,
} = {}) {
  const requests = new Map();
  return function verificationRequestLimiter(req, res, next) {
    const timestamp = now();
    const ip = String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 128);
    const history = (requests.get(ip) || []).filter(requestedAt => timestamp - requestedAt < windowMs);
    if (history.length >= maxIpRequests) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((history[0] + windowMs - timestamp) / 1000))));
      return res.status(429).json({ message: 'Too many verification requests. Please try again later.' });
    }
    requests.set(ip, [...history, timestamp]);
    while (requests.size > maxTrackedIps) requests.delete(requests.keys().next().value);
    next();
  };
}

module.exports = createVerificationRequestLimiter();
module.exports.createVerificationRequestLimiter = createVerificationRequestLimiter;
