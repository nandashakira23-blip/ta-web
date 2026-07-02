const mysql = require('mysql2');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function setupDatabase() {
    console.log('Starting database setup...');
    
    // Create connection without database first
    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        multipleStatements: true
    });

    try {
        // Read SQL file
        const sqlFile = path.join(__dirname, '..', 'database.sql');
        const sqlContent = fs.readFileSync(sqlFile, 'utf8');
        
        console.log('SQL file loaded successfully');
        
        // Execute SQL
        await new Promise((resolve, reject) => {
            connection.query(sqlContent, (err, results) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(results);
                }
            });
        });
        
        console.log('Database setup completed successfully!');
        console.log('Tables created:');
        console.log('   - pengaturan (location settings)');
        console.log('   - karyawan (employees)');
        console.log('   - presensi (attendance)');
        console.log('   - admin (admin users)');
        console.log('');
        console.log('Default admin login:');
        console.log('   Username: admin');
        console.log('   Password: admin123');
        console.log('');
        console.log('Ready to run: npm start');
        
    } catch (error) {
        console.error('Database setup failed:', error.message);
        
        if (error.code === 'ECONNREFUSED') {
            console.log('Tips:');
            console.log('   - Make sure MySQL server is running');
            console.log('   - Check your .env database credentials');
        } else if (error.code === 'ER_ACCESS_DENIED_ERROR') {
            console.log('Tips:');
            console.log('   - Check your MySQL username/password in .env');
            console.log('   - Make sure user has CREATE DATABASE privileges');
        }
    } finally {
        connection.end();
    }
}

// Run setup
setupDatabase();
