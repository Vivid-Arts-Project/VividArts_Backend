const express = require('express');
const router = express.Router();

// 🔐 1. CUSTOMER LOGIN ROUTE
// (When the frontend tries to login, the request comes here)
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // 💡 [For testing only]: Allow login only if email is admin@gmail.com and password is 1234
        if (email === 'admin@gmail.com' && password === '1234') {
            
            // This sends a "successfully logged in" message to the Frontend (Status 200)
            return res.status(200).json({ 
                success: true, 
                message: "Login successful! Welcome back." 
            });

        } else {
            
            // If login details are incorrect, sends a "Login failed" message to the Frontend (Status 401)
            return res.status(401).json({ 
                success: false, 
                message: "Login failed! Incorrect email or password." 
            });
        }
    } catch (error) {
        // If a server error occurs in the Backend (Status 500)
        return res.status(500).json({ success: false, message: "Server error occurred." });
    }
});

// 🎨 2. CUSTOMER PLACE ORDER ROUTE
// (When an order is placed from the frontend, the request comes here)
router.post('/order', async (req, res) => {
    try {
        const { paperSize, frameType } = req.body;

        // Checks if the customer has selected both options from the Frontend
        if (paperSize && frameType) {
            
            // If everything is correct, sends an "Order created" message to the Frontend (Status 201)
            return res.status(201).json({ 
                success: true, 
                message: "Order created successfully!" 
            });

        } else {
            
            // If any required details are missing, sends an "Order failed" message to the Frontend (Status 400)
            return res.status(400).json({ 
                success: false, 
                message: "Order creation failed! Please select all options." 
            });
        }
    } catch (error) {
        return res.status(500).json({ success: false, message: "Server error occurred." });
    }
});

// Export this route file to the server
module.exports = router;