/**
 * ============================================
 * CLEANUP SQLITE FILES
 * ============================================
 * 
 * Script ini akan:
 * 1. Menghapus file SQLite database
 * 2. Menghapus folder data jika kosong
 * 3. Membersihkan referensi SQLite di file reference
 * 
 * Usage: npm run cleanup:sqlite
 */

const fs = require('fs');
const path = require('path');

async function cleanupSQLite() {
    console.log('🧹 Starting SQLite cleanup...\n');
    
    try {
        // 1. Hapus file database SQLite
        const dbPath = path.join(__dirname, '..', 'data', 'presensi.db');
        if (fs.existsSync(dbPath)) {
            fs.unlinkSync(dbPath);
            console.log('✅ Removed SQLite database file: data/presensi.db');
        } else {
            console.log('ℹ️  SQLite database file not found (already removed)');
        }
        
        // 2. Hapus folder data jika kosong
        const dataDir = path.join(__dirname, '..', 'data');
        if (fs.existsSync(dataDir)) {
            const files = fs.readdirSync(dataDir);
            if (files.length === 0) {
                fs.rmdirSync(dataDir);
                console.log('✅ Removed empty data directory');
            } else {
                console.log(`ℹ️  Data directory contains ${files.length} files, keeping it`);
            }
        }
        
        // 3. Hapus file reference SQLite jika ada
        const referenceDbPath = path.join(__dirname, '..', 'reference', 'database.js');
        if (fs.existsSync(referenceDbPath)) {
            fs.unlinkSync(referenceDbPath);
            console.log('✅ Removed reference SQLite database file');
        }
        
        console.log('\n🎉 SQLite cleanup completed successfully!');
        console.log('\n📝 What was cleaned:');
        console.log('   ✅ SQLite database files removed');
        console.log('   ✅ Empty directories cleaned');
        console.log('   ✅ Reference files removed');
        console.log('\n💡 Next steps:');
        console.log('   1. Run: npm run setup:mysql');
        console.log('   2. Start server: npm start');
        
    } catch (error) {
        console.error('❌ Cleanup failed:', error.message);
        process.exit(1);
    }
}

// Run cleanup if called directly
if (require.main === module) {
    cleanupSQLite();
}

module.exports = { cleanupSQLite };