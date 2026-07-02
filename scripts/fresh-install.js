const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function freshInstall() {
    console.log('Starting fresh database installation...');
    
    try {
        // Create connection without database first
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASS
        });

        console.log('Connected to MySQL server');

        // Drop database if exists
        console.log('Dropping existing database...');
        await connection.execute(`DROP DATABASE IF EXISTS ${process.env.DB_NAME}`);
        
        // Create fresh database
        console.log('Creating fresh database...');
        await connection.execute(`CREATE DATABASE ${process.env.DB_NAME}`);
        
        await connection.end();
        console.log('Fresh database created successfully!');

        // Now run migrations
        console.log('Running migrations...');
        const { runMigrations } = require('./migrate');
        await runMigrations();

    } catch (error) {
        console.error('Fresh install failed:', error.message);
        
        if (error.code === 'ECONNREFUSED') {
            console.log('Tips:');
            console.log('   - Make sure MySQL server is running');
            console.log('   - Check your .env database credentials');
        } else if (error.code === 'ER_ACCESS_DENIED_ERROR') {
            console.log('Tips:');
            console.log('   - Check your MySQL username/password in .env');
            console.log('   - Make sure user has CREATE/DROP DATABASE privileges');
        }
    }
}

// Run if called directly
if (require.main === module) {
    freshInstall();
}

module.exports = { freshInstall };