const express = require('express');
const cors = require('cors');
const publicRoutes = require('./routes/public.routes');
const adminRoutes = require('./routes/admin.routes');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api', publicRoutes);
app.use('/api', adminRoutes);

module.exports = app;
