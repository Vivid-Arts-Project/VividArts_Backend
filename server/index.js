const express = require('express');
const session = require('express-session');
const app = express();
const cors = require('cors');

app.use(express.json());
app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true,
}));

app.use(session({
  secret: process.env.SESSION_SECRET || 'default_secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false,
    maxAge: 1000 * 60 * 60 * 8,
  },
}));

const db = require('./models');

const customerRouter = require('./routes/Customer');
const adminAuthRouter = require('./routes/adminAuth');

app.use('/customers', customerRouter);
app.use('/api/admin', adminAuthRouter);

app.get('/', (req, res) => res.json({ message: 'Vivid Arts backend is running' }));

db.sequelize.sync().then(() => {
  app.listen(3001, () => {
    console.log('Server is running on port 3001');
  });
}).catch((err) => {
  console.error('Unable to connect to the database:', err);
});