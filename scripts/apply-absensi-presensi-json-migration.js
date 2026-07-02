const mysql = require('mysql2/promise');
require('dotenv').config();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'presensi_fleur_atelier',
  multipleStatements: false
};

async function tableExists(connection, tableName) {
  const [rows] = await connection.execute(
    `SELECT TABLE_NAME
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?`,
    [tableName]
  );
  return rows.length > 0;
}

async function columnExists(connection, tableName, columnName) {
  const [rows] = await connection.execute(
    `SELECT COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  return rows.length > 0;
}

async function indexExists(connection, tableName, indexName) {
  const [rows] = await connection.execute(
    `SELECT INDEX_NAME
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND INDEX_NAME = ?`,
    [tableName, indexName]
  );
  return rows.length > 0;
}

async function constraintExists(connection, tableName, constraintName) {
  const [rows] = await connection.execute(
    `SELECT CONSTRAINT_NAME
     FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND CONSTRAINT_NAME = ?`,
    [tableName, constraintName]
  );
  return rows.length > 0;
}

async function addColumnIfMissing(connection, tableName, columnName, ddl) {
  if (!(await columnExists(connection, tableName, columnName))) {
    await connection.execute(`ALTER TABLE ${tableName} ADD COLUMN ${ddl}`);
    console.log(`Added ${tableName}.${columnName}`);
  }
}

async function run() {
  const connection = await mysql.createConnection(dbConfig);
  try {
    console.log(`Connected to ${dbConfig.database}`);

    const hasKetidakhadiran = await tableExists(connection, 'ketidakhadiran');
    const hasAbsensi = await tableExists(connection, 'absensi');
    if (hasKetidakhadiran && !hasAbsensi) {
      await connection.execute('RENAME TABLE ketidakhadiran TO absensi');
      console.log('Renamed ketidakhadiran to absensi');
    }

    if (!(await tableExists(connection, 'absensi'))) {
      throw new Error('Table absensi not found after migration preparation');
    }

    await connection.execute(`
      ALTER TABLE absensi
      MODIFY jenis ENUM('cuti','izin','sakit') NOT NULL
    `);

    await addColumnIfMissing(connection, 'absensi', 'id_pengganti', 'id_pengganti BIGINT NULL AFTER lampiran');
    await addColumnIfMissing(connection, 'absensi', 'catatan_pengganti', 'catatan_pengganti TEXT NULL AFTER status');
    await addColumnIfMissing(connection, 'absensi', 'approved_pengganti_at', 'approved_pengganti_at DATETIME NULL AFTER catatan_pengganti');

    await connection.execute(`
      ALTER TABLE absensi
      MODIFY status ENUM(
        'pending',
        'approved',
        'rejected',
        'cancelled',
        'menunggu_pengganti',
        'ditolak_pengganti',
        'menunggu_manager',
        'disetujui',
        'ditolak',
        'dibatalkan'
      ) NOT NULL DEFAULT 'menunggu_manager'
    `);

    await connection.execute(`UPDATE absensi SET status = 'menunggu_manager' WHERE status = 'pending'`);
    await connection.execute(`UPDATE absensi SET status = 'disetujui' WHERE status = 'approved'`);
    await connection.execute(`UPDATE absensi SET status = 'ditolak' WHERE status = 'rejected'`);
    await connection.execute(`UPDATE absensi SET status = 'dibatalkan' WHERE status = 'cancelled'`);

    if (!(await indexExists(connection, 'absensi', 'idx_absensi_pengganti'))) {
      await connection.execute('ALTER TABLE absensi ADD INDEX idx_absensi_pengganti (id_pengganti)');
    }

    if (!(await constraintExists(connection, 'absensi', 'fk_absensi_pengganti'))) {
      await connection.execute(`
        ALTER TABLE absensi
        ADD CONSTRAINT fk_absensi_pengganti
        FOREIGN KEY (id_pengganti) REFERENCES karyawan(id)
        ON DELETE SET NULL
      `);
    }

    await addColumnIfMissing(connection, 'presensi', 'data_masuk', 'data_masuk JSON NULL AFTER leave_request_id');
    await addColumnIfMissing(connection, 'presensi', 'data_keluar', 'data_keluar JSON NULL AFTER data_masuk');

    if (await tableExists(connection, 'event_presensi')) {
      await connection.execute(`
        UPDATE presensi p
        SET data_masuk = COALESCE(
          data_masuk,
          (
            SELECT JSON_OBJECT(
              'metode', ep.metode,
              'foto', ep.foto,
              'latitude', ep.latitude,
              'longitude', ep.longitude,
              'jarak_meter', ep.distance_meter,
              'face_similarity', ep.face_similarity,
              'device_info', ep.device_info
            )
            FROM event_presensi ep
            WHERE ep.id_karyawan = p.id_karyawan
              AND DATE(ep.waktu_event) = p.tanggal
              AND ep.jenis_event = 'check_in'
            ORDER BY ep.waktu_event ASC
            LIMIT 1
          )
        )
        WHERE data_masuk IS NULL
      `);

      await connection.execute(`
        UPDATE presensi p
        SET data_keluar = COALESCE(
          data_keluar,
          (
            SELECT JSON_OBJECT(
              'metode', ep.metode,
              'foto', ep.foto,
              'latitude', ep.latitude,
              'longitude', ep.longitude,
              'jarak_meter', ep.distance_meter,
              'face_similarity', ep.face_similarity,
              'device_info', ep.device_info
            )
            FROM event_presensi ep
            WHERE ep.id_karyawan = p.id_karyawan
              AND DATE(ep.waktu_event) = p.tanggal
              AND ep.jenis_event = 'check_out'
            ORDER BY ep.waktu_event DESC
            LIMIT 1
          )
        )
        WHERE data_keluar IS NULL
      `);

      console.log('Backfilled presensi JSON columns from event_presensi where available');
    }

    console.log('Absensi/presensi JSON migration completed');
  } finally {
    await connection.end();
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
}

module.exports = { run };
