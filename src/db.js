// src/db.js
const knex = require('knex');
const knexConfig = require('../knexfile');

// Use development or production config based on NODE_ENV
const environment = process.env.NODE_ENV || 'development';
const config = knexConfig[environment];

const db = knex(config);

// Test connection
db.raw('SELECT 1')
  .then(() => {
    console.log('✅ Database connected successfully');
  })
  .catch((error) => {
    console.error('❌ Database connection failed:', error.message);
    process.exit(1);
  });

module.exports = db;
