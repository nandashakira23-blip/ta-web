/**
 * Patch idempoten: menambah kolom `permintaan_absensi.dilihat_pengganti` (0/1) bila belum ada.
 * Dipakai agar notifikasi "tugas pengganti (urgent)" di beranda berhenti muncul setelah
 * pengganti membuka daftarnya. AMAN untuk DB live (additive, DEFAULT 0, tidak mengubah data).
 *
 * Jalankan: node scripts/patch-dilihat-pengganti.js  (boleh berkali-kali).
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
         AND TABLE_NAME = 'permintaan_absensi'
         AND COLUMN_NAME = 'dilihat_pengganti'
       LIMIT 1`
    );
    if (cols.length > 0) {
      console.log('OK: kolom permintaan_absensi.dilihat_pengganti sudah ada. Tidak ada perubahan.');
      return;
    }
    await connection.execute(
      `ALTER TABLE permintaan_absensi
       ADD COLUMN dilihat_pengganti TINYINT(1) NOT NULL DEFAULT 0 AFTER status`
    );
    console.log('OK: kolom permintaan_absensi.dilihat_pengganti ditambahkan (default 0).');
  } finally {
    await connection.end();
  }
}

run().catch((e) => { console.error('GAGAL patch dilihat_pengganti:', e.message); process.exit(1); });
