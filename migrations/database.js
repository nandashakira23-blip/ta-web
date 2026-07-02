/**
 * Migration: Inisialisasi Skema Indonesia 
 * Tujuan:
 * - Menstandarkan skema basis data ke nama tabel/field bahasa Indonesia.
 * - Menjadikan seluruh tabel dan field aktif menggunakan penamaan Indonesia.
 */

const bcrypt = require('bcryptjs');

function escapeIdentifier(identifier) {
  return `\`${String(identifier).replace(/`/g, '``')}\``;
}

async function hapusSemuaObjekSkema(connection) {
  const [rows] = await connection.execute(
    `SELECT TABLE_NAME, TABLE_TYPE
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()`
  );

  for (const row of rows) {
    const namaObjek = escapeIdentifier(row.TABLE_NAME);
    if (row.TABLE_TYPE === 'VIEW') {
      await connection.execute(`DROP VIEW IF EXISTS ${namaObjek}`);
    } else {
      await connection.execute(`DROP TABLE IF EXISTS ${namaObjek}`);
    }
  }
}

async function up(connection) {
  console.log('Migrating...');

  const [existingObjects] = await connection.execute(
    `SELECT TABLE_NAME
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
     LIMIT 1`
  );

  if (
    process.env.NODE_ENV === 'production' &&
    existingObjects.length > 0 &&
    process.env.ALLOW_DESTRUCTIVE_MIGRATION !== 'true'
  ) {
    throw new Error(
      'Refusing to run destructive production migration on a non-empty database. ' +
      'Create a safe incremental migration or set ALLOW_DESTRUCTIVE_MIGRATION=true only after taking a backup.'
    );
  }

  await connection.execute('SET FOREIGN_KEY_CHECKS = 0');
  await hapusSemuaObjekSkema(connection);

  await connection.execute('SET FOREIGN_KEY_CHECKS = 1');

  // 1) Master
  await connection.execute(`
    CREATE TABLE jabatan (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      kode VARCHAR(30) NOT NULL UNIQUE,
      nama_jabatan VARCHAR(100) NOT NULL,
      deskripsi TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at DATETIME NULL,
      INDEX idx_jabatan_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await connection.execute(`
    CREATE TABLE shift (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      kode_shift VARCHAR(30) NOT NULL UNIQUE,
      nama_shift VARCHAR(100) NOT NULL,
      jam_masuk TIME NOT NULL,
      jam_keluar TIME NOT NULL,
      status BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at DATETIME NULL,
      INDEX idx_shift_active (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await connection.execute(`
    CREATE TABLE jadwal_kerja (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      nama VARCHAR(100) NOT NULL,
      shift_id BIGINT NULL,
      hari_kerja JSON NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at DATETIME NULL,
      CONSTRAINT fk_jadwal_shift FOREIGN KEY (shift_id) REFERENCES shift(id) ON DELETE SET NULL,
      INDEX idx_jadwal_shift (shift_id),
      INDEX idx_jadwal_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 3) Karyawan
  await connection.execute(`
    CREATE TABLE karyawan (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      nik CHAR(16) NOT NULL UNIQUE,
      nama VARCHAR(100) NOT NULL,
      email VARCHAR(100) NULL UNIQUE,
      tanggal_lahir DATE NULL,
      phone VARCHAR(20) NULL,
      id_jabatan BIGINT NULL,
      shift_id BIGINT NULL,
      id_jadwal_kerja BIGINT NULL,
      status ENUM('draft', 'active', 'inactive', 'resigned') NOT NULL DEFAULT 'draft',
      profile_picture VARCHAR(255) NULL,
      address TEXT NULL,
      pin_hash VARCHAR(255) NULL,
      face_enrollment_completed BOOLEAN NOT NULL DEFAULT FALSE,
      email_verification_token VARCHAR(20) NULL,
      email_verification_expires_at DATETIME NULL,
      email_verification_sent_at DATETIME NULL,
      email_verified_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at DATETIME NULL,
      CONSTRAINT fk_karyawan_jabatan FOREIGN KEY (id_jabatan) REFERENCES jabatan(id) ON DELETE SET NULL,
      CONSTRAINT fk_karyawan_shift FOREIGN KEY (shift_id) REFERENCES shift(id) ON DELETE SET NULL,
      CONSTRAINT fk_karyawan_jadwal FOREIGN KEY (id_jadwal_kerja) REFERENCES jadwal_kerja(id) ON DELETE SET NULL,
      INDEX idx_karyawan_status (status),
      INDEX idx_karyawan_jabatan (id_jabatan),
      INDEX idx_karyawan_jadwal (id_jadwal_kerja)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 4) Absensi: pengajuan cuti/izin/sakit (sesuai diagram)
  await connection.execute(`
    CREATE TABLE absensi (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      id_karyawan BIGINT NOT NULL,
      jenis ENUM('cuti', 'izin', 'sakit') NOT NULL,
      kategori ENUM('full_day', 'half_day', 'hourly') NOT NULL DEFAULT 'full_day',
      tanggal_mulai DATE NOT NULL,
      tanggal_selesai DATE NOT NULL,
      jam_mulai TIME NULL,
      jam_selesai TIME NULL,
      durasi_menit INT NOT NULL DEFAULT 0,
      alasan TEXT NOT NULL,
      lampiran VARCHAR(255) NULL,
      status ENUM(
        'menunggu_pengganti',
        'ditolak_pengganti',
        'menunggu_manager',
        'disetujui',
        'ditolak',
        'dibatalkan'
      ) NOT NULL DEFAULT 'menunggu_manager',
      approval_notes TEXT NULL,
      approved_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_absensi_karyawan FOREIGN KEY (id_karyawan) REFERENCES karyawan(id) ON DELETE CASCADE,
      INDEX idx_absensi_status (status),
      INDEX idx_absensi_karyawan_tanggal (id_karyawan, tanggal_mulai, tanggal_selesai)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 4b) Permintaan Absensi: junction table untuk pengganti (sesuai diagram)
  await connection.execute(`
    CREATE TABLE permintaan_absensi (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      id_absensi BIGINT NOT NULL,
      id_pengganti BIGINT NOT NULL,
      id_pemohon BIGINT NOT NULL,
      catatan TEXT NULL,
      status ENUM('menunggu', 'disetujui', 'ditolak') NOT NULL DEFAULT 'menunggu',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_permintaan_absensi_absensi FOREIGN KEY (id_absensi) REFERENCES absensi(id) ON DELETE CASCADE,
      CONSTRAINT fk_permintaan_absensi_pengganti FOREIGN KEY (id_pengganti) REFERENCES karyawan(id) ON DELETE CASCADE,
      CONSTRAINT fk_permintaan_absensi_pemohon FOREIGN KEY (id_pemohon) REFERENCES karyawan(id) ON DELETE CASCADE,
      INDEX idx_permintaan_absensi_status (status),
      INDEX idx_permintaan_absensi_pengganti (id_pengganti, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 5) Presensi
  await connection.execute(`
    CREATE TABLE presensi (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      id_karyawan BIGINT NOT NULL,
      tanggal DATE NOT NULL,
      jam_masuk DATETIME NULL,
      jam_keluar DATETIME NULL,
      status ENUM('present', 'late', 'absent', 'leave', 'sick', 'holiday') NOT NULL DEFAULT 'present',
      total_work_minutes INT NOT NULL DEFAULT 0,
      approved_leave_minutes INT NOT NULL DEFAULT 0,
      effective_work_minutes INT NOT NULL DEFAULT 0,
      overtime_minutes INT NOT NULL DEFAULT 0,
      late_minutes INT NOT NULL DEFAULT 0,
      early_leave_minutes INT NOT NULL DEFAULT 0,
      data_masuk JSON NULL,
      data_keluar JSON NULL,
      keterangan TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_presensi_karyawan FOREIGN KEY (id_karyawan) REFERENCES karyawan(id) ON DELETE CASCADE,
      UNIQUE KEY uk_presensi_karyawan_tanggal (id_karyawan, tanggal),
      INDEX idx_presensi_status_tanggal (status, tanggal)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 6) Wajah
  await connection.execute(`
    CREATE TABLE karyawan_face_reference (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      id_karyawan BIGINT NOT NULL,
      face_encoding JSON NOT NULL,
      photo_path VARCHAR(255) NOT NULL,
      enrollment_method ENUM('manual', 'auto', 'bulk') NOT NULL DEFAULT 'manual',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_face_ref_karyawan FOREIGN KEY (id_karyawan) REFERENCES karyawan(id) ON DELETE CASCADE,
      INDEX idx_face_ref_karyawan_active (id_karyawan, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 7) Pengaturan, token, manager
  await connection.execute(`
    CREATE TABLE pengaturan (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      lat_kantor DECIMAL(10,8) NOT NULL DEFAULT -6.20000000,
      long_kantor DECIMAL(11,8) NOT NULL DEFAULT 106.81666600,
      radius_meter INT NOT NULL DEFAULT 100,
      pin_required BOOLEAN NOT NULL DEFAULT TRUE,
      pin_max_attempts INT NOT NULL DEFAULT 3,
      pin_lockout_minutes INT NOT NULL DEFAULT 30,
      face_and_pin_required BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await connection.execute(`
    CREATE TABLE refresh_tokens (
      id CHAR(36) PRIMARY KEY,
      id_karyawan BIGINT NOT NULL,
      token_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      revoked_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_refresh_karyawan FOREIGN KEY (id_karyawan) REFERENCES karyawan(id) ON DELETE CASCADE,
      UNIQUE KEY uk_refresh_hash (token_hash),
      INDEX idx_refresh_karyawan (id_karyawan),
      INDEX idx_refresh_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 8) User (akun login web) — superadmin / manager standalone, tidak terkait karyawan
  await connection.execute(`
    CREATE TABLE user (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      role ENUM('superadmin', 'manager') NOT NULL DEFAULT 'manager',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user_role (role)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Seed minimum
  const hashAdmin = await bcrypt.hash('admin123', 10);
  const hashPin = await bcrypt.hash('123456', 10);

  await connection.execute(`
    INSERT INTO user (username, password, role)
    VALUES ('admin', ?, 'superadmin')
  `, [hashAdmin]);

  await connection.execute(`
    INSERT INTO pengaturan (
      lat_kantor, long_kantor, radius_meter,
      pin_required, pin_max_attempts, pin_lockout_minutes,
      face_and_pin_required
    ) VALUES (-6.20000000, 106.81666600, 100, TRUE, 3, 30, TRUE)
  `);

  await connection.execute(`
    INSERT INTO jabatan (kode, nama_jabatan, deskripsi, is_active)
    VALUES
      ('MGR', 'Manager', 'Mengelola operasional tim', TRUE),
      ('STF', 'Staff', 'Menjalankan operasional harian', TRUE)
  `);

  await connection.execute(`
    INSERT INTO shift (
      kode_shift, nama_shift, jam_masuk, jam_keluar, status
    ) VALUES
      ('PAGI', 'Shift Pagi', '08:00:00', '17:00:00', TRUE),
      ('SIANG', 'Shift Siang', '13:00:00', '21:00:00', TRUE)
  `);

  await connection.execute(`
    INSERT INTO jadwal_kerja (
      nama, shift_id, hari_kerja, is_active
    )
    VALUES (
      'Weekday Morning',
      (SELECT id FROM shift WHERE kode_shift = 'PAGI' LIMIT 1),
      JSON_ARRAY('Monday','Tuesday','Wednesday','Thursday','Friday'),
      TRUE
    )
  `);

  await connection.execute(`
    INSERT INTO karyawan (
      nik, nama, email, phone, id_jabatan, shift_id, id_jadwal_kerja,
      status, address, pin_hash
    ) VALUES (
      '1111111111111111',
      'Demo Employee',
      'employee@demo.local',
      '081234567890',
      (SELECT id FROM jabatan WHERE kode = 'STF' LIMIT 1),
      (SELECT id FROM shift WHERE kode_shift = 'PAGI' LIMIT 1),
      (SELECT id FROM jadwal_kerja ORDER BY id LIMIT 1),
      'active',
      'Demo Address',
      ?
    )
  `, [hashPin]);

  console.log('Migrasi selesai: Skema Indonesia aktif');
}

async function down(connection) {
  console.log('Rollback migrasi: Inisialisasi Skema Indonesia (Tunggal)');

  await connection.execute('SET FOREIGN_KEY_CHECKS = 0');
  await hapusSemuaObjekSkema(connection);

  await connection.execute('SET FOREIGN_KEY_CHECKS = 1');
  console.log('Rollback selesai');
}

module.exports = { up, down };
