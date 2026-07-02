/**
 * ============================================
 * COMPLETE SETUP - MYSQL MIGRATION
 * ============================================
 * 
 * Script ini akan melakukan setup lengkap dari SQLite ke MySQL:
 * 1. Cleanup SQLite files
 * 2. Setup MySQL database
 * 3. Verifikasi koneksi
 * 4. Test basic functionality
 * 
 * Usage: npm run setup:complete
 */

const { cleanupSQLite } = require('./cleanup-sqlite');
const { setupMySQL } = require('./setup-mysql');
const mysql = require('mysql2/promise');
require('dotenv').config();

async function completeSetup() {
    console.log('🚀 Starting Complete MySQL Migration Setup...\n');
    
    try {
        // Step 1: Cleanup SQLite
        console.log('📋 Phase 1: Cleaning up SQLite files...');
        await cleanupSQLite();
        console.log('✅ SQLite cleanup completed\n');
        
        // Step 2: Setup MySQL
        console.log('📋 Phase 2: Setting up MySQL database...');
        await setupMySQL();
        console.log('✅ MySQL setup completed\n');
        
        // Step 3: Verify connection and basic functionality
        console.log('📋 Phase 3: Verifying setup...');
        await verifySetup();
        console.log('✅ Verification completed\n');
        
        console.log('🎉 COMPLETE SETUP SUCCESSFUL! 🎉\n');
        console.log('📝 Summary:');
        console.log('   ✅ SQLite files removed');
        console.log('   ✅ MySQL database created and configured');
        console.log('   ✅ All migrations applied');
        console.log('   ✅ Default data seeded');
        console.log('   ✅ Connection verified');
        console.log('\n🚀 Next Steps:');
        console.log('   1. Start the server: npm start');
        console.log('   2. Access admin panel: http://localhost:3000/admin');
        console.log('   3. Login with: admin / admin123');
        console.log('   4. Test Android app connection');
        
    } catch (error) {
        console.error('❌ Complete setup failed:', error.message);
        console.error('\n🔧 Troubleshooting:');
        console.error('   1. Check MySQL server is running');
        console.error('   2. Verify .env database configuration');
        console.error('   3. Ensure MySQL user has proper permissions');
        console.error('   4. Check network connectivity');
        process.exit(1);
    }
}

async function verifySetup() {
    let connection = null;
    
    try {
        // Test database connection
        connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASS || '',
            database: process.env.DB_NAME
        });
        
        console.log('   ✅ Database connection successful');
        
        // Test basic queries
        const [tables] = await connection.execute('SHOW TABLES');
        console.log(`   ✅ Found ${tables.length} tables in database`);
        
        // Test default superadmin exists
        const [adminUsers] = await connection.execute(
            "SELECT COUNT(*) as count FROM user WHERE username = ? AND role = 'superadmin'",
            ['admin']
        );
        if (adminUsers[0].count > 0) {
            console.log('   ✅ Default superadmin user exists');
        } else {
            console.log('   ⚠️  Default superadmin user not found');
        }
        
        // Test karyawan table structure
        const [karyawanColumns] = await connection.execute('SHOW COLUMNS FROM karyawan');
        const requiredColumns = ['id', 'nik', 'nama', 'pin_hash', 'status', 'id_jadwal_kerja'];
        const existingColumns = karyawanColumns.map(col => col.Field);
        
        let missingColumns = requiredColumns.filter(col => !existingColumns.includes(col));
        if (missingColumns.length === 0) {
            console.log('   ✅ Karyawan table structure is correct');
        } else {
            console.log(`   ⚠️  Missing columns in karyawan table: ${missingColumns.join(', ')}`);
        }
        
        // Test presensi table structure
        const [presensiColumns] = await connection.execute('SHOW COLUMNS FROM presensi');
        const presensiRequiredColumns = ['id', 'id_karyawan', 'attendance_type', 'lat_absen', 'long_absen'];
        const presensiExistingColumns = presensiColumns.map(col => col.Field);
        
        let presensiMissingColumns = presensiRequiredColumns.filter(col => !presensiExistingColumns.includes(col));
        if (presensiMissingColumns.length === 0) {
            console.log('   ✅ Presensi table structure is correct');
        } else {
            console.log(`   ⚠️  Missing columns in presensi table: ${presensiMissingColumns.join(', ')}`);
        }
        
        // Test face recognition tables
        const faceRecognitionTables = ['karyawan_face_reference', 'presensi_face_log'];
        for (const tableName of faceRecognitionTables) {
            try {
                await connection.execute(`SELECT 1 FROM ${tableName} LIMIT 1`);
                console.log(`   ✅ ${tableName} table exists and accessible`);
            } catch (error) {
                console.log(`   ⚠️  ${tableName} table issue: ${error.message}`);
            }
        }
        
        // Test work schedule tables
        try {
            const [schedules] = await connection.execute('SELECT COUNT(*) as count FROM jadwal_kerja');
            console.log(`   ✅ Work schedules table exists with ${schedules[0].count} schedules`);
        } catch (error) {
            console.log(`   ⚠️  Work schedules table issue: ${error.message}`);
        }
        
    } catch (error) {
        console.error('   ❌ Verification failed:', error.message);
        throw error;
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

// Run complete setup if called directly
if (require.main === module) {
    completeSetup();
}

module.exports = { completeSetup };
