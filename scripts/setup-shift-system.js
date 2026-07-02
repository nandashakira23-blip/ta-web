/**
 * ============================================
 * SETUP SISTEM SHIFT KARYAWAN & ABSENSI
 * ============================================
 * 
 * Sistem shift yang masuk akal untuk FLEUR CAFÉ:
 * 1. 3 Shift utama (Pagi, Siang, Malam)
 * 2. Jadwal khusus (Weekend, Holiday)
 * 3. Sistem absensi fleksibel
 * 4. Overtime dan break time
 * 
 * Usage: npm run setup:shifts
 */

const mysql = require('mysql2/promise');
require('dotenv').config();

async function setupShiftSystem() {
    console.log('Setting up realistic shift system for FLEUR CAFÉ...\n');
    
    let connection = null;
    
    try {
        connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASS || '',
            database: process.env.DB_NAME
        });
        
        console.log('Connected to database\n');
        
        // 1. Setup Jadwal Shift Realistis
        await setupWorkSchedules(connection);
        
        // 2. Setup Jabatan Karyawan Café
        await setupJobPositions(connection);
        
        // 3. Setup Karyawan Sample
        await setupSampleEmployees(connection);
        
        // 4. Setup Aturan Absensi
        await setupAttendanceRules(connection);
        
        console.log('\n✅ Shift system setup completed successfully!');
        console.log('\n📋 Summary:');
        console.log('   - 5 work schedules created (Morning, Day, Evening, Weekend, Holiday)');
        console.log('   - 6 job positions created (Manager, Barista, Cashier, etc.)');
        console.log('   - 8 sample employees created');
        console.log('   - Attendance rules configured');
        
        console.log('\n🏪 FLEUR CAFÉ Shift System:');
        console.log('   🌅 Morning Shift: 06:00 - 14:00 (Opening crew)');
        console.log('   ☀️  Day Shift: 09:00 - 17:00 (Peak hours)');
        console.log('   🌙 Evening Shift: 14:00 - 22:00 (Closing crew)');
        console.log('   🎉 Weekend Shift: 08:00 - 20:00 (Weekend coverage)');
        console.log('   🎊 Holiday Shift: 10:00 - 18:00 (Holiday hours)');
        
    } catch (error) {
        console.error('❌ Setup failed:', error.message);
        process.exit(1);
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

async function setupWorkSchedules(connection) {
    console.log('📅 Setting up work schedules...');
    
    // Hapus jadwal lama jika ada
    await connection.execute('DELETE FROM jadwal_kerja WHERE id > 1');
    
    const schedules = [
        {
            nama: 'Morning Shift - Opening Crew',
            jam_masuk: '06:00:00',
            jam_keluar: '14:00:00',
            batas_absen_masuk_awal: '05:45:00',
            batas_absen_masuk_akhir: '06:15:00',
            batas_absen_keluar_awal: '13:45:00',
            batas_absen_keluar_akhir: '14:30:00',
            jam_istirahat_mulai: '09:00:00',
            jam_istirahat_selesai: '09:30:00',
            hari_kerja: JSON.stringify(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']),
            description: 'Shift pagi untuk persiapan pembukaan café, prep makanan, dan melayani customer pagi'
        },
        {
            nama: 'Day Shift - Peak Hours',
            jam_masuk: '09:00:00',
            jam_keluar: '17:00:00',
            batas_absen_masuk_awal: '08:45:00',
            batas_absen_masuk_akhir: '09:15:00',
            batas_absen_keluar_awal: '16:45:00',
            batas_absen_keluar_akhir: '17:30:00',
            jam_istirahat_mulai: '12:30:00',
            jam_istirahat_selesai: '13:30:00',
            hari_kerja: JSON.stringify(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']),
            description: 'Shift siang untuk jam sibuk, lunch rush, dan customer reguler'
        },
        {
            nama: 'Evening Shift - Closing Crew',
            jam_masuk: '14:00:00',
            jam_keluar: '22:00:00',
            batas_absen_masuk_awal: '13:45:00',
            batas_absen_masuk_akhir: '14:15:00',
            batas_absen_keluar_awal: '21:45:00',
            batas_absen_keluar_akhir: '22:30:00',
            jam_istirahat_mulai: '18:00:00',
            jam_istirahat_selesai: '18:30:00',
            hari_kerja: JSON.stringify(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']),
            description: 'Shift sore untuk dinner service, cleaning, dan penutupan café'
        },
        {
            nama: 'Weekend Shift - Full Day',
            jam_masuk: '08:00:00',
            jam_keluar: '20:00:00',
            batas_absen_masuk_awal: '07:45:00',
            batas_absen_masuk_akhir: '08:15:00',
            batas_absen_keluar_awal: '19:45:00',
            batas_absen_keluar_akhir: '20:30:00',
            jam_istirahat_mulai: '14:00:00',
            jam_istirahat_selesai: '15:00:00',
            hari_kerja: JSON.stringify(['saturday', 'sunday']),
            description: 'Shift weekend dengan jam lebih panjang untuk weekend crowd'
        },
        {
            nama: 'Holiday Shift - Special Hours',
            jam_masuk: '10:00:00',
            jam_keluar: '18:00:00',
            batas_absen_masuk_awal: '09:45:00',
            batas_absen_masuk_akhir: '10:15:00',
            batas_absen_keluar_awal: '17:45:00',
            batas_absen_keluar_akhir: '18:30:00',
            jam_istirahat_mulai: '13:00:00',
            jam_istirahat_selesai: '14:00:00',
            hari_kerja: JSON.stringify(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']),
            description: 'Shift khusus untuk hari libur nasional dengan jam terbatas'
        }
    ];
    
    for (const schedule of schedules) {
        await connection.execute(`
            INSERT INTO jadwal_kerja 
            (nama, jam_masuk, jam_keluar, batas_absen_masuk_awal, batas_absen_masuk_akhir, 
             batas_absen_keluar_awal, batas_absen_keluar_akhir, jam_istirahat_mulai, 
             jam_istirahat_selesai, hari_kerja, is_active) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)
        `, [
            schedule.nama,
            schedule.jam_masuk,
            schedule.jam_keluar,
            schedule.batas_absen_masuk_awal,
            schedule.batas_absen_masuk_akhir,
            schedule.batas_absen_keluar_awal,
            schedule.batas_absen_keluar_akhir,
            schedule.jam_istirahat_mulai,
            schedule.jam_istirahat_selesai,
            schedule.hari_kerja
        ]);
    }
    
    console.log('   ✅ 5 work schedules created');
}

async function setupJobPositions(connection) {
    console.log('👥 Setting up job positions...');
    
    // Hapus jabatan lama kecuali yang sudah ada
    await connection.execute('DELETE FROM jabatan WHERE id > 6');
    
    const positions = [
        {
            nama_jabatan: 'Store Manager',
            deskripsi: 'Mengelola operasional café, supervisi staff, dan customer service'
        },
        {
            nama_jabatan: 'Assistant Manager',
            deskripsi: 'Membantu manager, koordinasi shift, dan training karyawan baru'
        },
        {
            nama_jabatan: 'Head Barista',
            deskripsi: 'Barista senior, quality control minuman, dan training barista junior'
        },
        {
            nama_jabatan: 'Barista',
            deskripsi: 'Membuat kopi dan minuman, maintain coffee machine, customer service'
        },
        {
            nama_jabatan: 'Cashier',
            deskripsi: 'Melayani pembayaran, order taking, dan customer service di counter'
        },
        {
            nama_jabatan: 'Kitchen Staff',
            deskripsi: 'Persiapan makanan, food prep, maintain kitchen cleanliness'
        },
        {
            nama_jabatan: 'Server/Waitress',
            deskripsi: 'Melayani customer di meja, food delivery, dan maintain dining area'
        },
        {
            nama_jabatan: 'Cleaning Staff',
            deskripsi: 'Maintenance kebersihan café, dishwashing, dan general cleaning'
        }
    ];
    
    for (const position of positions) {
        await connection.execute(`
            INSERT IGNORE INTO jabatan (nama_jabatan, deskripsi, is_active) 
            VALUES (?, ?, TRUE)
        `, [position.nama_jabatan, position.deskripsi]);
    }
    
    console.log('   ✅ 8 job positions created');
}

async function setupSampleEmployees(connection) {
    console.log('👤 Setting up sample employees...');
    
    // Hapus karyawan sample lama
    await connection.execute('DELETE FROM karyawan WHERE nik LIKE "FLEUR%"');
    
    const employees = [
        {
            nik: 'FLEUR001',
            nama: 'Sarah Manager',
            email: 'sarah@fleurcafe.com',
            phone: '081234567001',
            id_jabatan: 1, // Store Manager
            id_jadwal_kerja: 2, // Day Shift
            is_activated: false
        },
        {
            nik: 'FLEUR002',
            nama: 'David Assistant',
            email: 'david@fleurcafe.com',
            phone: '081234567002',
            id_jabatan: 2, // Assistant Manager
            id_jadwal_kerja: 2, // Day Shift
            is_activated: false
        },
        {
            nik: 'FLEUR003',
            nama: 'Maya Barista',
            email: 'maya@fleurcafe.com',
            phone: '081234567003',
            id_jabatan: 3, // Head Barista
            id_jadwal_kerja: 1, // Morning Shift
            is_activated: false
        },
        {
            nik: 'FLEUR004',
            nama: 'Andi Coffee',
            email: 'andi@fleurcafe.com',
            phone: '081234567004',
            id_jabatan: 4, // Barista
            id_jadwal_kerja: 2, // Day Shift
            is_activated: false
        },
        {
            nik: 'FLEUR005',
            nama: 'Lisa Cashier',
            email: 'lisa@fleurcafe.com',
            phone: '081234567005',
            id_jabatan: 5, // Cashier
            id_jadwal_kerja: 1, // Morning Shift
            is_activated: false
        },
        {
            nik: 'FLEUR006',
            nama: 'Rudi Kitchen',
            email: 'rudi@fleurcafe.com',
            phone: '081234567006',
            id_jabatan: 6, // Kitchen Staff
            id_jadwal_kerja: 1, // Morning Shift
            is_activated: false
        },
        {
            nik: 'FLEUR007',
            nama: 'Nina Server',
            email: 'nina@fleurcafe.com',
            phone: '081234567007',
            id_jabatan: 7, // Server/Waitress
            id_jadwal_kerja: 3, // Evening Shift
            is_activated: false
        },
        {
            nik: 'FLEUR008',
            nama: 'Budi Cleaning',
            email: 'budi@fleurcafe.com',
            phone: '081234567008',
            id_jabatan: 8, // Cleaning Staff
            id_jadwal_kerja: 3, // Evening Shift
            is_activated: false
        }
    ];
    
    for (const employee of employees) {
        await connection.execute(`
            INSERT INTO karyawan 
            (nik, nama, email, phone, id_jabatan, id_jadwal_kerja, is_activated) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            employee.nik,
            employee.nama,
            employee.email,
            employee.phone,
            employee.id_jabatan,
            employee.id_jadwal_kerja,
            employee.is_activated
        ]);
    }
    
    console.log('   ✅ 8 sample employees created');
}

async function setupAttendanceRules(connection) {
    console.log('⚙️ Setting up attendance rules...');
    
    // Update pengaturan untuk aturan absensi
    await connection.execute(`
        UPDATE pengaturan SET 
            radius_meter = 50,
            pin_required = TRUE,
            pin_max_attempts = 3,
            pin_lockout_minutes = 30,
            face_and_pin_required = TRUE
        WHERE id = 1
    `);
    
    // face_recognition_settings table removed - not used in API
    
    console.log('   ✅ Attendance rules configured');
}

// Run setup if called directly
if (require.main === module) {
    setupShiftSystem();
}

module.exports = { setupShiftSystem };