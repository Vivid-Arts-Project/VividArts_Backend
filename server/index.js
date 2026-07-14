require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path    = require('path');
const app = express();
const cors = require('cors');

app.use(express.json()); // Middleware to parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Middleware to parse form-encoded bodies (e.g. PayHere webhook)
app.use(cors({
    origin: 'http://localhost:3000', // Allow requests from this origin
    credentials: true, // Allow cookies to be sent

})); // Enable CORS for all routes

app.use(session({
    secret: process.env.SESSION_SECRET || 'default_secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set to true if using HTTPS
}));
const db = require('./models');

//Routers
const customerRouter = require('./routes/Customer');
const paymentRouter = require('./routes/Payment');
app.use("/api/customers", customerRouter);
app.use("/api/payments", paymentRouter);


db.sequelize.sync().then(() => {
    app.listen(3001,() =>{

        console.log('Server is running on port 3001');
    });
}).catch((err) => {
    console.error('Unable to connect to the database:', err);
});

app.use(express.json());