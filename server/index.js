require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cors    = require('cors');
const app     = express();
const port    = Number(process.env.PORT) || 5000;
const isProduction = process.env.NODE_ENV === 'production';
const db = require('./models');
const SequelizeSessionStore = require('./sessionStore');
const sessionStore = new SequelizeSessionStore(db.AdminSession);

const sessionSecret = process.env.SESSION_SECRET || '';
const weakSessionSecret = sessionSecret.length < 32
  || /change[_-]?this|replace[_-]?with|development[_-]?only/i.test(sessionSecret);
if (isProduction && weakSessionSecret) {
  throw new Error('SESSION_SECRET must be set to a strong value of at least 32 characters in production');
}
if (isProduction) app.set('trust proxy', 1);

// ── 1. Body parsers ───────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // needed for PayHere webhook
app.use('/uploads', express.static(require('path').join(__dirname, 'uploads')));

// Never expose database, provider, or stack details in 5xx JSON responses.
app.use((req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = body => {
    if (res.statusCode < 500 || !body || typeof body !== 'object') return sendJson(body);
    console.error(`[api-error] ${req.method} ${req.originalUrl}:`, body.error || body.message || 'Internal server error');
    return sendJson({
      ...(Object.hasOwn(body, 'success') ? { success: false } : {}),
      ...(Object.hasOwn(body, 'message') ? { message: 'Unable to complete this request.' } : {}),
      error: 'Unable to complete this request.',
    });
  };
  next();
});

// ── 2. CORS ───────────────────────────────────────────────────────────────────
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  process.env.FRONTEND_URL,
].filter(Boolean).map(origin => origin.replace(/\/$/, ''));

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ''))) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS'));
  },
  credentials: true, // required so session cookie is sent with every request
}));

// ── 3. Session (MUST come before any route that reads req.session) ─────────────
app.use(session({
  name: 'vividarts.admin.sid',
  secret: sessionSecret || 'development-only-session-secret-change-me',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    maxAge: 1000 * 60 * 60 * 8, // 8 hours
  },
}));

// SameSite cookies are the primary CSRF boundary; origin verification adds a
// second check for every cookie-authenticated state-changing request.
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const hasCustomerCookie = (req.headers.cookie || '').includes('vividarts.customer.token=');
  if (!hasCustomerCookie) return next();
  const origin = req.get('origin');
  if (origin && allowedOrigins.includes(origin.replace(/\/$/, ''))) return next();
  return res.status(403).json({ error: 'Invalid request origin' });
});

// Reject cross-site state changes that carry an authenticated admin cookie.
app.use('/api/admin', (req, res, next) => {
  if (!req.session?.adminId || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin && allowedOrigins.includes(origin.replace(/\/$/, ''))) return next();
  return res.status(403).json({ error: 'Invalid request origin' });
});

// ── 4. Database ───────────────────────────────────────────────────────────────

// ── 5. Routes ─────────────────────────────────────────────────────────────────
const customerRouter  = require('./routes/Customer');
const paymentRouter   = require('./routes/Payment');
const adminAuthRouter = require('./routes/adminAuth');  // login, register, /me
const adminRouter     = require('./routes/admin');       // orders, proofs, pricing
const ordersRouter = require('./routes/orders');
const contentRouter = require('./routes/content');
const { ensurePriceCatalog } = require('./utils/pricing');

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api/customers', customerRouter);
app.use('/api/payments',  paymentRouter);
app.use('/api/admin',     adminAuthRouter); // POST /api/admin/login etc.
app.use('/api/admin',     adminRouter);     // GET  /api/admin/orders etc.
app.use('/api/orders', ordersRouter);
app.use('/api/content', contentRouter);

// ── 6. Sync DB and start ──────────────────────────────────────────────────────
// Create any missing tables once on startup without resetting existing data.
db.sequelize.authenticate()
  .then(async () => {
    await ensurePriceCatalog();
    await sessionStore.clearExpired();
    app.listen(port, () => console.log(`✓ Server running on http://localhost:${port}`));
  })
  .catch(err => console.error('✗ DB connection failed:', err));
