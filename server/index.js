require('dotenv').config();

const express = require('express');
const session = require('express-session');
const app = express();
const cors = require('cors');

<<<<<<< HEAD
app.use(express.json());
=======
app.use(express.json()); // Middleware to parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Middleware to parse form-encoded bodies (e.g. PayHere webhook)
>>>>>>> f5a39824058c1407ac6a20f49f9fea5d4e990e28
app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true,
}));

app.use(session({
<<<<<<< HEAD
  secret: process.env.SESSION_SECRET || 'default_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false },
=======
    secret: process.env.SESSION_SECRET || 'default_secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,       // JS cannot read the cookie — security best practice
        secure:   false,      // set true when you deploy with HTTPS
        maxAge:   1000 * 60 * 60 * 8,
    } // Set to true if using HTTPS
>>>>>>> f5a39824058c1407ac6a20f49f9fea5d4e990e28
}));

const db = require('./models');
const customerRouter = require('./routes/Customer');
<<<<<<< HEAD
const paymentsRouter = require('./routes/Payments');
const commissionsRouter = require('./routes/Commissions');

app.get('/', (req, res) => {
  res.json({ message: 'VividArts backend is running' });
=======
const paymentRouter = require('./routes/Payment');
const adminAuthRouter = require('./routes/adminAuth');
app.use("/api/customers", customerRouter);
app.use("/api/payments", paymentRouter);
app.use('/api/admin', adminAuthRouter);


db.sequelize.sync({ alter: true }).then(() => {
    app.listen(3001,() =>{

        console.log('Server is running on port 3001');
    });
}).catch((err) => {
    console.error('Unable to connect to the database:', err);
>>>>>>> f5a39824058c1407ac6a20f49f9fea5d4e990e28
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