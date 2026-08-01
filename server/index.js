require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cors    = require('cors');
const app     = express();

// ── 1. Body parsers ───────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // needed for PayHere webhook

// ── 2. CORS ───────────────────────────────────────────────────────────────────
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:5173'],
  credentials: true, // required so session cookie is sent with every request
}));

// ── 3. Session (MUST come before any route that reads req.session) ─────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'change_this_in_production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false,              // set true when running on HTTPS
    maxAge: 1000 * 60 * 60 * 8, // 8 hours
  },
}));

// ── 4. Database ───────────────────────────────────────────────────────────────
const db = require('./models');

// ── 5. Routes ─────────────────────────────────────────────────────────────────
const customerRouter  = require('./routes/Customer');
const paymentRouter   = require('./routes/Payment');
const adminAuthRouter = require('./routes/adminAuth');  // login, register, /me
const adminRouter     = require('./routes/admin');       // orders, proofs, pricing
const ordersRouter = require('./routes/orders');

app.use('/api/customers', customerRouter);
app.use('/api/payments',  paymentRouter);
app.use('/api/admin',     adminAuthRouter); // POST /api/admin/login etc.
app.use('/api/admin',     adminRouter);     // GET  /api/admin/orders etc.
app.use('/api/orders', ordersRouter);

// ── 6. Sync DB and start ──────────────────────────────────────────────────────
// Verify the connection without mutating the schema on every restart.
// This project has cyclic model references, for which Sequelize sync() performs
// an internal alter pass that can repeatedly create duplicate MySQL indexes.
// Apply schema changes with migrations instead.
db.sequelize.authenticate().then(() => {
  app.listen(3001, () => console.log('✓ Server running on http://localhost:3001'));
}).catch(err => console.error('✗ DB connection failed:', err));
