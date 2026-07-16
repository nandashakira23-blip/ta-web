const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
require('dotenv').config();
const { getMysqlConfig } = require('../config/mysql');

const WORK_DAYS_MON_SAT = JSON.stringify([
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday'
]);

const WORK_DAYS_FULL_WEEK = JSON.stringify([
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday'
]);

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

async function seedDatabase() {
    console.log('Starting database seeding...');
    
    let connection;
    
    try {
        connection = await mysql.createConnection(getMysqlConfig());

        console.log('Connected to database');

        // 1. Insert default pengaturan (office location settings)
        console.log('Seeding pengaturan...');
        const [settingUpdate] = await connection.execute(`
            UPDATE pengaturan
            SET lat_kantor = -8.8155675,
                long_kantor = 115.1253343,
                radius_meter = 100
            ORDER BY id
            LIMIT 1
        `);

        if (!settingUpdate.affectedRows) {
            await connection.execute(`
                INSERT INTO pengaturan (lat_kantor, long_kantor, radius_meter)
                VALUES (-8.8155675, 115.1253343, 100)
            `);
        }

        // 2. Insert jabatan (job positions) — kode format JAB-timestamp, statis
        console.log('Seeding jabatan...');
        await connection.execute(`
            INSERT INTO jabatan (kode, nama_jabatan, deskripsi, is_active) VALUES
            ('JAB-1782864001001', 'Manager', 'Manajer operasional', TRUE),
            ('JAB-1782864002002', 'Barista', 'Pembuat kopi dan minuman', TRUE),
            ('JAB-1782864003003', 'Cashier', 'Kasir dan pelayanan', TRUE),
            ('JAB-1782864004004', 'Kitchen Staff', 'Staff dapur', TRUE),
            ('JAB-1782864005005', 'Waitress', 'Pelayan', TRUE),
            ('JAB-1782864006006', 'Cleaning Service', 'Petugas kebersihan', TRUE),
            ('JAB-1782864007007', 'Security', 'Petugas keamanan', TRUE),
            ('JAB-1782864008008', 'Admin', 'Staff administrasi', TRUE)
            ON DUPLICATE KEY UPDATE
                nama_jabatan = VALUES(nama_jabatan),
                deskripsi = VALUES(deskripsi),
                is_active = VALUES(is_active),
                deleted_at = NULL
        `);

        // 3. Insert shift & work schedule (sesuai kebutuhan operasional)
        console.log('Seeding shift...');
        await connection.execute(`
            INSERT INTO shift (kode_shift, nama_shift, jam_masuk, jam_keluar, status) VALUES
            ('MORNING', 'Morning Shift', '06:30:00', '14:30:00', TRUE),
            ('MIDDLE', 'Middle Shift', '08:30:00', '16:30:00', TRUE),
            ('CLOSING', 'Closing Shift', '10:30:00', '18:30:00', TRUE)
            ON DUPLICATE KEY UPDATE
                nama_shift = VALUES(nama_shift),
                jam_masuk = VALUES(jam_masuk),
                jam_keluar = VALUES(jam_keluar),
                status = VALUES(status),
                deleted_at = NULL
        `);

        console.log('Seeding jadwal kerja...');
        const schedules = [
            {
                nama: 'Regular Morning (Mon-Sat)',
                kodeShift: 'MORNING',
                hariKerja: WORK_DAYS_MON_SAT
            },
            {
                nama: 'Regular Middle (Mon-Sat)',
                kodeShift: 'MIDDLE',
                hariKerja: WORK_DAYS_MON_SAT
            },
            {
                nama: 'Regular Closing (Mon-Sat)',
                kodeShift: 'CLOSING',
                hariKerja: WORK_DAYS_MON_SAT
            },
            {
                nama: 'Full Week (Mon-Sun)',
                kodeShift: 'MIDDLE',
                hariKerja: WORK_DAYS_FULL_WEEK
            },
            {
                nama: 'Morning & Water Check (Mon-Sat)',
                kodeShift: 'MORNING',
                hariKerja: WORK_DAYS_MON_SAT
            }
        ];

        for (const schedule of schedules) {
            const [updateResult] = await connection.execute(`
                UPDATE jadwal_kerja jk
                JOIN shift s ON s.kode_shift = ?
                SET
                    jk.shift_id = s.id,
                    jk.hari_kerja = ?,
                    jk.is_active = TRUE,
                    jk.deleted_at = NULL
                WHERE jk.nama = ?
            `, [schedule.kodeShift, schedule.hariKerja, schedule.nama]);

            if (!updateResult.affectedRows) {
                await connection.execute(`
                    INSERT INTO jadwal_kerja (nama, shift_id, hari_kerja, is_active)
                    SELECT ?, s.id, ?, TRUE
                    FROM shift s
                    WHERE s.kode_shift = ?
                `, [schedule.nama, schedule.hariKerja, schedule.kodeShift]);
            }
        }

        // 4. Insert superadmin users (di tabel user dengan role='superadmin')
        console.log('Seeding superadmin users...');
        const hashedPassword = await bcrypt.hash('admin123', 10);
        await connection.execute(`
            INSERT IGNORE INTO user (username, password, role) VALUES
            ('admin', ?, 'superadmin'),
            ('superadmin', ?, 'superadmin')
        `, [hashedPassword, hashedPassword]);

        // 5. Insert sample karyawan (employees)
        console.log('Seeding sample employees...');
        const employees = [
            { nik: 'EMP001', nama: 'John Doe', kodeJabatan: 'JAB-1782864002002' },
            { nik: 'EMP002', nama: 'Jane Smith', kodeJabatan: 'JAB-1782864001001' },
            { nik: 'EMP003', nama: 'Bob Wilson', kodeJabatan: 'JAB-1782864003003' },
            { nik: 'EMP004', nama: 'Alice Johnson', kodeJabatan: 'JAB-1782864004004' },
            { nik: 'EMP005', nama: 'Mike Brown', kodeJabatan: 'JAB-1782864005005' },
            { nik: 'EMP006', nama: 'Sarah Davis', kodeJabatan: 'JAB-1782864006006' },
            { nik: 'EMP007', nama: 'Tom Anderson', kodeJabatan: 'JAB-1782864007007' },
            { nik: 'EMP008', nama: 'Lisa Wilson', kodeJabatan: 'JAB-1782864008008' }
        ];

        for (const employee of employees) {
            await connection.execute(`
                INSERT INTO karyawan (nik, nama, id_jabatan, status)
                VALUES (
                    ?,
                    ?,
                    (SELECT id FROM jabatan WHERE kode = ? LIMIT 1),
                    'draft'
                )
                ON DUPLICATE KEY UPDATE
                    nama = VALUES(nama),
                    id_jabatan = VALUES(id_jabatan),
                    deleted_at = NULL
            `, [employee.nik, employee.nama, employee.kodeJabatan]);
        }

        // 6. Assign default work schedule to employees (pakai regular middle)
        console.log('Assigning work schedules to employees...');
        await connection.execute(`
            UPDATE karyawan
            SET id_jadwal_kerja = (
                SELECT id
                FROM jadwal_kerja
                WHERE nama = 'Regular Middle (Mon-Sat)'
                ORDER BY id DESC
                LIMIT 1
            )
            WHERE id_jadwal_kerja IS NULL
        `);

        await connection.execute(`
            UPDATE karyawan k
            LEFT JOIN jadwal_kerja jk ON jk.id = k.id_jadwal_kerja
            SET k.shift_id = jk.shift_id
            WHERE k.shift_id IS NULL
        `);

        console.log('');
        console.log('Database seeding completed successfully!');
        console.log('');
        console.log('Seeded data:');
        console.log('   - 1 office location setting');
        console.log('   - 8 job positions');
        console.log('   - 2 admin users');
        console.log('   - 8 sample employees');
        console.log('   - 3 shift kerja (Morning, Middle, Closing)');
        console.log('   - 5 jadwal kerja (Regular, Full, Morning & Water Check)');
        console.log('   - Work schedules assigned');
        console.log('');
        console.log('Admin login credentials:');
        console.log('   Username: admin / superadmin');
        console.log('   Password: admin123');
        console.log('');
        console.log('Sample employees (NIK):');
        console.log('   EMP001 - John Doe (Barista)');
        console.log('   EMP002 - Jane Smith (Manager)');
        console.log('   EMP003 - Bob Wilson (Cashier)');
        console.log('   EMP004 - Alice Johnson (Kitchen Staff)');
        console.log('   EMP005 - Mike Brown (Waitress)');
        console.log('   EMP006 - Sarah Davis (Cleaning Service)');
        console.log('   EMP007 - Tom Anderson (Security)');
        console.log('   EMP008 - Lisa Wilson (Admin)');
        console.log('');
        console.log('Shifts:');
        console.log('   - Morning Shift (06:30-14:30)');
        console.log('   - Middle Shift (08:30-16:30)');
        console.log('   - Closing Shift (10:30-18:30)');
        console.log('');
        console.log('Work Schedules:');
        console.log('   - Regular Morning (Mon-Sat)');
        console.log('   - Regular Middle (Mon-Sat)');
        console.log('   - Regular Closing (Mon-Sat)');
        console.log('   - Full Week (Mon-Sun)');
        console.log('   - Morning & Water Check (Mon-Sat)');
        console.log('');
        console.log('Ready to run: npm start');

    } catch (error) {
        console.error('Seeding failed:', error.message);
        
        if (error.code === 'ECONNREFUSED') {
            console.log('Tips:');
            console.log('   - Make sure MySQL server is running');
            console.log('   - Check your .env database credentials');
        } else if (error.code === 'ER_ACCESS_DENIED_ERROR') {
            console.log('Tips:');
            console.log('   - Check your MySQL username/password in .env');
            console.log('   - Make sure user has INSERT privileges');
        } else if (error.code === 'ER_NO_SUCH_TABLE') {
            console.log('Tips:');
            console.log('   - Run migrations first: npm run migrate:up');
            console.log('   - Or run fresh install: npm run db:fresh');
        }
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

async function clearSeeds() {
    console.log('Clearing seed data...');
    
    let connection;
    
    try {
        connection = await mysql.createConnection(getMysqlConfig());

        // Clear data in reverse order of dependencies
        await connection.execute('SET FOREIGN_KEY_CHECKS = 0');
        
        console.log('Clearing attendance data...');
        await connection.execute('DELETE FROM presensi');
        if (await tableExists(connection, 'absensi')) {
            await connection.execute('DELETE FROM absensi');
        }
        await connection.execute('DELETE FROM karyawan_face_reference');
        
        console.log('Clearing employee data...');
        await connection.execute('DELETE FROM karyawan');
        
        console.log('Clearing job positions...');
        await connection.execute('DELETE FROM jabatan');
        
        console.log('Clearing admin users...');
        await connection.execute("DELETE FROM user WHERE role = 'superadmin'");
        
        console.log('Clearing work schedules...');
        await connection.execute(`
            DELETE FROM jadwal_kerja
            WHERE nama IN (
                'Regular Morning (Mon-Sat)',
                'Regular Middle (Mon-Sat)',
                'Regular Closing (Mon-Sat)',
                'Full Week (Mon-Sun)',
                'Morning & Water Check (Mon-Sat)'
            )
        `);
        await connection.execute(`
            DELETE FROM shift
            WHERE kode_shift IN ('MORNING', 'MIDDLE', 'CLOSING')
        `);
        
        console.log('Clearing office settings...');
        await connection.execute('DELETE FROM pengaturan');
        
        await connection.execute('SET FOREIGN_KEY_CHECKS = 1');
        
        console.log('Seed data cleared successfully!');

    } catch (error) {
        console.error('Clear seeds failed:', error.message);
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

// Command line interface
const command = process.argv[2];

if (command === 'run') {
    seedDatabase();
} else if (command === 'clear') {
    clearSeeds();
} else {
    console.log('Usage:');
    console.log('  npm run seed        - Run database seeding');
    console.log('  npm run seed:clear  - Clear seed data');
    console.log('');
    console.log('Or directly:');
    console.log('  node scripts/seed.js run    - Run seeding');
    console.log('  node scripts/seed.js clear  - Clear seeds');
}

module.exports = { seedDatabase, clearSeeds };
