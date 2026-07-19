require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path    = require('path');
const app = express();
const cors = require('cors');

app.use(express.json()); // Middleware to parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Middleware to parse form-encoded bodies (e.g. PayHere webhook)
app.use(cors({
    origin: ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true,
})); // Enable CORS for all routes

app.use(session({
    secret: process.env.SESSION_SECRET || 'default_secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,       // JS cannot read the cookie — security best practice
        secure:   false,      // set true when you deploy with HTTPS
        maxAge:   1000 * 60 * 60 * 8,
    } // Set to true if using HTTPS
}));
const db = require('./models');

//Routers
const customerRouter = require('./routes/Customer');
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
});

app.use(express.json());