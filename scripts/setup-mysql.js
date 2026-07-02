/**
 * ============================================
 * SETUP DATABASE MYSQL LENGKAP
 * ============================================
 * 
 * Script ini akan:
 * 1. Membuat database MySQL jika belum ada
 * 2. Menjalankan semua migrasi secara berurutan
 * 3. Mengisi data seed default
 * 4. Verifikasi struktur database
 * 
 * Usage: npm run setup:mysql
 */

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function setupMySQL() {
    let connection = null;
    
    try {
        console.log('🚀 Starting MySQL Database Setup...\n');
        
        // Step 1: Create database if not exists
        console.log('📊 Step 1: Creating database...');
        connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASS || ''
        });
        
        await connection.execute(`CREATE DATABASE IF NOT EXISTS ${process.env.DB_NAME}`);
        console.log(`✅ Database '${process.env.DB_NAME}' created/verified\n`);
        
        await connection.end();
        
        // Step 2: Connect to the database
        console.log('🔗 Step 2: Connecting to database...');
        connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASS || '',
            database: process.env.DB_NAME
        });
        console.log('✅ Connected to database\n');
        
        // Step 3: Run migrations
        console.log('📋 Step 3: Running migrations...');
        const migrationsDir = path.join(__dirname, '..', 'migrations');
        const migrationFiles = fs.readdirSync(migrationsDir)
            .filter(file => file.endsWith('.js'))
            .sort();
        
        for (const file of migrationFiles) {
            console.log(`   Running migration: ${file}`);
            const migration = require(path.join(migrationsDir, file));
            
            if (migration.up) {
                await migration.up(connection);
                console.log(`   ✅ ${file} completed`);
            }
        }
        console.log('✅ All migrations completed\n');
        
        // Step 4: Verify database structure
        console.log('🔍 Step 4: Verifying database structure...');
        const [tables] = await connection.execute('SHOW TABLES');
        console.log(`✅ Found ${tables.length} tables:`);
        
        for (const table of tables) {
            const tableName = Object.values(table)[0];
            const [columns] = await connection.execute(`SHOW COLUMNS FROM ${tableName}`);
            console.log(`   📋 ${tableName} (${columns.length} columns)`);
        }
        
        console.log('\n🎉 MySQL Database Setup Completed Successfully!');
        console.log('\n📝 Next steps:');
        console.log('   1. Start the server: npm start');
        console.log('   2. Access admin panel: http://localhost:3000/admin');
        console.log('   3. Default admin login: admin / admin123');
        
    } catch (error) {
        console.error('❌ Setup failed:', error.message);
        console.error('\n💡 Troubleshooting:');
        console.error('   1. Make sure MySQL server is running');
        console.error('   2. Check your .env database configuration');
        console.error('   3. Verify MySQL user has CREATE DATABASE permission');
        process.exit(1);
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

// Run setup if called directly
if (require.main === module) {
    setupMySQL();
}

module.exports = { setupMySQL };