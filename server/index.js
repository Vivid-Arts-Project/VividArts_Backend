const express = require('express');
const session = require('express-session');
const app = express();
const cors = require('cors');

app.use(express.json());
app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true,
}));

app.use(session({
  secret: process.env.SESSION_SECRET || 'default_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false },
}));

const db = require('./models');
const customerRouter = require('./routes/Customer');
const paymentsRouter = require('./routes/Payments');
const commissionsRouter = require('./routes/Commissions');

app.get('/', (req, res) => {
  res.json({ message: 'VividArts backend is running' });
});

app.use('/api/customers', customerRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/commissions', commissionsRouter);

async function startServer() {
  try {
    await db.sequelize.authenticate();
    await db.sequelize.sync();
    console.log('Database connected and synced');
  } catch (err) {
    console.warn('Database unavailable, starting server without DB sync:', err.message);
  }

  app.listen(3001, () => {
    console.log('Server is running on port 3001');
  });
}

startServer();