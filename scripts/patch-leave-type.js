/**
 * Patch idempoten: menambah kolom `absensi.leave_type` (planned/urgent) bila belum ada.
 * AMAN untuk database live — bersifat additive (ADD COLUMN dengan DEFAULT), tidak menghapus
 * atau mengubah data yang sudah ada. Baris lama otomatis bernilai 'planned'.
 *
 * Jalankan: node scripts/patch-leave-type.js
 * Boleh dijalankan berkali-kali (kalau kolom sudah ada, tidak melakukan apa-apa).
 */
const mysql = require('mysql2/promise');
require('../config/env')();
const { getMysqlConfig } = require('../config/mysql');

async function run() {
  const connection = await mysql.createConnection(getMysqlConfig());
  try {
    const [cols] = await connection.execute(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'absensi'
         AND COLUMN_NAME = 'leave_type'
       LIMIT 1`
    );

    if (cols.length > 0) {
      console.log('OK: kolom absensi.leave_type sudah ada. Tidak ada perubahan.');
      return;
    }

    await connection.execute(
      `ALTER TABLE absensi
       ADD COLUMN leave_type ENUM('planned','urgent') NOT NULL DEFAULT 'planned' AFTER jenis`
    );

    const [check] = await connection.execute(
      `SELECT COUNT(*) AS total,
              SUM(leave_type = 'planned') AS planned
       FROM absensi`
    );
    console.log('OK: kolom absensi.leave_type ditambahkan.');
    console.log(`   Baris absensi lama: ${check[0].total} (semua = 'planned' by default: ${check[0].planned}).`);
  } finally {
    await connection.end();
  }
}

run().catch((e) => {
  console.error('GAGAL patch leave_type:', e.message);
  process.exit(1);
});
