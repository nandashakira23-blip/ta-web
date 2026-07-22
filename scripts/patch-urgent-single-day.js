/**
 * Patch data idempoten: izin URGENT secara definisi = kejadian mendadak SATU hari, jadi
 * tanggal_selesai harus sama dengan tanggal_mulai. Data lama (mis. hasil testing) yang
 * terlanjur punya rentang multi-hari membuat label "menggantikan" muncul di banyak tanggal
 * presensi pengganti. Script ini menyetel tanggal_selesai = tanggal_mulai untuk semua izin
 * urgent yang rentangnya masih multi-hari. AMAN dijalankan berkali-kali.
 *
 * Jalankan: node scripts/patch-urgent-single-day.js
 */
const mysql = require('mysql2/promise');
require('../config/env')();
const { getMysqlConfig } = require('../config/mysql');

async function run() {
  const connection = await mysql.createConnection(getMysqlConfig());
  try {
    const [before] = await connection.execute(
      `SELECT id, id_karyawan,
              DATE_FORMAT(tanggal_mulai,'%Y-%m-%d') AS mulai,
              DATE_FORMAT(tanggal_selesai,'%Y-%m-%d') AS selesai
         FROM absensi
        WHERE leave_type = 'urgent' AND tanggal_selesai > tanggal_mulai`
    );
    if (before.length === 0) {
      console.log('OK: tidak ada izin urgent multi-hari. Tidak ada perubahan.');
      return;
    }
    console.log('Izin urgent multi-hari yang akan dikolaps ke 1 hari:');
    console.table(before);
    const [res] = await connection.execute(
      `UPDATE absensi
          SET tanggal_selesai = tanggal_mulai
        WHERE leave_type = 'urgent' AND tanggal_selesai > tanggal_mulai`
    );
    console.log(`OK: ${res.affectedRows} baris diperbarui (tanggal_selesai = tanggal_mulai).`);
  } finally {
    await connection.end();
  }
}

run().catch((e) => { console.error('GAGAL patch urgent-single-day:', e.message); process.exit(1); });
