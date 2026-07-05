const express = require('express');
const router = express.Router();
const {customers} = require('../models'); // Import your models here

    router.get('/', async(req, res) => {
       // res.json('Customer route is working');
       const listOfCustomers = await customers.findAll();
       res.json(listOfCustomers);
    });

    router.post('/', async (req, res) => {
        //res.send('Customer POST route is working');
        const customer = req.body; // Assuming you have body-parser middleware set up
        await customers.create(customer);
        res.json(customer);
        //res.status(201).send('Customer created successfully');
    });


module.exports = router;