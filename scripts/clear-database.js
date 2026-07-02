/**
 * Script untuk membersihkan semua data di database
 * Menghapus semua data tapi tetap mempertahankan struktur tabel
 * 
 * PERINGATAN: Script ini akan menghapus SEMUA data!
 * - Semua karyawan
 * - Semua presensi
 * - Semua log
 * - Semua referensi wajah
 * 
 * Hanya admin default yang akan tetap ada.
 */

const mysql = require('mysql2/promise');
require('dotenv').config();

async function clearDatabase() {
  let connection;
  
  try {
    console.log('==============================================');
    console.log('⚠️  PERINGATAN - CLEAR DATABASE');
    console.log('==============================================');
    console.log('Script ini akan menghapus SEMUA data di database!');
    console.log('Struktur tabel akan tetap dipertahankan.');
    console.log('==============================================\n');

    console.log('Connecting to database...');
    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME
    });

    console.log('Connected to database:', process.env.DB_NAME);
    console.log('\nStarting data cleanup...\n');

    // Disable foreign key checks temporarily
    await connection.execute('SET FOREIGN_KEY_CHECKS = 0');

    // 1. Clear absensi face log
    console.log('1. Clearing presensi_face_log...');
    const [faceLog] = await connection.execute('SELECT COUNT(*) as count FROM presensi_face_log');
    await connection.execute('TRUNCATE TABLE presensi_face_log');
    console.log(`   Deleted ${faceLog[0].count} records`);

    // 2. Clear presensi (attendance records)
    console.log('2. Clearing presensi...');
    const [presensi] = await connection.execute('SELECT COUNT(*) as count FROM presensi');
    await connection.execute('TRUNCATE TABLE presensi');
    console.log(`   Deleted ${presensi[0].count} records`);

    // 3. Clear karyawan face reference
    console.log('3. Clearing karyawan_face_reference...');
    const [faceRef] = await connection.execute('SELECT COUNT(*) as count FROM karyawan_face_reference');
    await connection.execute('TRUNCATE TABLE karyawan_face_reference');
    console.log(`   Deleted ${faceRef[0].count} records`);

    // 4. Clear karyawan (keep admin only)
    console.log('4. Clearing karyawan (keeping admin only)...');
    const [karyawan] = await connection.execute('SELECT COUNT(*) as count FROM karyawan WHERE role != "admin"');
    await connection.execute('DELETE FROM karyawan WHERE role != "admin"');
    console.log(`   Deleted ${karyawan[0].count} employee records`);

    // 5. Reset admin password
    console.log('5. Resetting admin password...');
    const bcrypt = require('bcrypt');
    const hashedPassword = await bcrypt.hash('admin123', 10);
    await connection.execute(
      'UPDATE karyawan SET password = ?, pin = NULL, is_activated = TRUE WHERE role = "admin"',
      [hashedPassword]
    );
    console.log('   Admin password reset to: admin123');

    // 6. Clear jabatan (keep default positions)
    console.log('6. Clearing jabatan (keeping defaults)...');
    const [jabatan] = await connection.execute('SELECT COUNT(*) as count FROM jabatan WHERE id > 3');
    await connection.execute('DELETE FROM jabatan WHERE id > 3');
    console.log(`   Deleted ${jabatan[0].count} custom positions`);

    // 7. Clear work schedules (keep default)
    console.log('7. Clearing work_schedule (keeping default)...');
    const [schedule] = await connection.execute('SELECT COUNT(*) as count FROM work_schedule WHERE id > 1');
    await connection.execute('DELETE FROM work_schedule WHERE id > 1');
    console.log(`   Deleted ${schedule[0].count} custom schedules`);

    // Re-enable foreign key checks
    await connection.execute('SET FOREIGN_KEY_CHECKS = 1');

    console.log('\n==============================================');
    console.log('DATABASE CLEANUP SUMMARY');
    console.log('==============================================');
    console.log('✅ All data cleared successfully!');
    console.log('\nRemaining data:');
    console.log('  - Admin user (username: admin, password: admin123)');
    console.log('  - Default jabatan (Manager, Staff, Intern)');
    console.log('  - Default work schedule (Regular 08:00-17:00)');
    console.log('  - Office settings');
    console.log('\nDatabase is ready for fresh data!');
    console.log('==============================================\n');

  } catch (error) {
    console.error('\n❌ Error clearing database:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
      console.log('Database connection closed');
    }
  }
}

// Konfirmasi sebelum menjalankan
console.log('\n⚠️  WARNING: This will delete ALL data from the database!');
console.log('Press Ctrl+C to cancel, or wait 5 seconds to continue...\n');

setTimeout(() => {
  clearDatabase();
}, 5000);
