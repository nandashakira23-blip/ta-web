/**
 * ============================================
 * SETUP KEBIJAKAN ABSENSI YANG MASUK AKAL
 * ============================================
 * 
 * Kebijakan absensi realistis untuk FLEUR CAFÉ:
 * 1. Toleransi keterlambatan
 * 2. Sistem overtime
 * 3. Break time management
 * 4. Penalty dan reward system
 * 5. Leave management
 * 
 * Usage: npm run setup:policies
 */

const mysql = require('mysql2/promise');
require('dotenv').config();

async function setupAttendancePolicies() {
    console.log('Setting up realistic attendance policies for FLEUR CAFÉ...\n');
    
    let connection = null;
    
    try {
        connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASS || '',
            database: process.env.DB_NAME
        });
        
        console.log('Connected to database\n');
        
        // 1. Setup Attendance Policies Table
        await createAttendancePoliciesTable(connection);
        
        // 2. Setup Leave Types
        await setupLeaveTypes(connection);
        
        // 3. Setup Penalty System
        await setupPenaltySystem(connection);
        
        // 4. Setup Overtime Rules
        await setupOvertimeRules(connection);
        
        // 5. Setup Holiday Calendar
        await setupHolidayCalendar(connection);
        
        console.log('\n✅ Attendance policies setup completed successfully!');
        console.log('\n📋 Policies Summary:');
        console.log('   - Tolerance: 15 minutes late allowed');
        console.log('   - Break time: 30-60 minutes depending on shift');
        console.log('   - Overtime: Auto-calculated after shift hours');
        console.log('   - Leave types: 5 types (Sick, Annual, Emergency, etc.)');
        console.log('   - Penalties: Progressive system for violations');
        console.log('   - Holidays: Indonesian national holidays configured');
        
    } catch (error) {
        console.error('❌ Setup failed:', error.message);
        process.exit(1);
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

async function createAttendancePoliciesTable(connection) {
    console.log('📋 Creating attendance policies table...');
    
    await connection.execute(`
        CREATE TABLE IF NOT EXISTS attendance_policies (
            id INT AUTO_INCREMENT PRIMARY KEY,
            policy_name VARCHAR(100) NOT NULL UNIQUE,
            policy_value TEXT NOT NULL,
            policy_type ENUM('time', 'boolean', 'number', 'text') DEFAULT 'text',
            description TEXT,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);
    
    const policies = [
        {
            policy_name: 'late_tolerance_minutes',
            policy_value: '15',
            policy_type: 'number',
            description: 'Toleransi keterlambatan dalam menit sebelum dianggap terlambat'
        },
        {
            policy_name: 'early_checkout_allowed',
            policy_value: 'true',
            policy_type: 'boolean',
            description: 'Apakah karyawan boleh checkout lebih awal dengan approval'
        },
        {
            policy_name: 'minimum_work_hours',
            policy_value: '6',
            policy_type: 'number',
            description: 'Minimum jam kerja per hari untuk full attendance'
        },
        {
            policy_name: 'maximum_overtime_hours',
            policy_value: '4',
            policy_type: 'number',
            description: 'Maximum jam overtime yang diizinkan per hari'
        },
        {
            policy_name: 'break_time_paid',
            policy_value: 'true',
            policy_type: 'boolean',
            description: 'Apakah break time dihitung sebagai jam kerja'
        },
        {
            policy_name: 'weekend_overtime_rate',
            policy_value: '1.5',
            policy_type: 'number',
            description: 'Rate overtime untuk weekend (1.5x normal rate)'
        },
        {
            policy_name: 'holiday_overtime_rate',
            policy_value: '2.0',
            policy_type: 'number',
            description: 'Rate overtime untuk hari libur (2x normal rate)'
        },
        {
            policy_name: 'consecutive_late_limit',
            policy_value: '3',
            policy_type: 'number',
            description: 'Batas keterlambatan berturut-turut sebelum penalty'
        },
        {
            policy_name: 'monthly_late_limit',
            policy_value: '5',
            policy_type: 'number',
            description: 'Batas total keterlambatan per bulan'
        },
        {
            policy_name: 'grace_period_new_employee',
            policy_value: '30',
            policy_type: 'number',
            description: 'Grace period untuk karyawan baru (dalam hari)'
        }
    ];
    
    for (const policy of policies) {
        await connection.execute(`
            INSERT INTO attendance_policies 
            (policy_name, policy_value, policy_type, description) 
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE 
                policy_value = VALUES(policy_value),
                updated_at = CURRENT_TIMESTAMP
        `, [policy.policy_name, policy.policy_value, policy.policy_type, policy.description]);
    }
    
    console.log('   ✅ Attendance policies configured');
}

async function setupLeaveTypes(connection) {
    console.log('🏖️ Setting up leave types...');
    
    await connection.execute(`
        CREATE TABLE IF NOT EXISTS leave_types (
            id INT AUTO_INCREMENT PRIMARY KEY,
            leave_name VARCHAR(50) NOT NULL,
            max_days_per_year INT DEFAULT 12,
            requires_approval BOOLEAN DEFAULT TRUE,
            requires_document BOOLEAN DEFAULT FALSE,
            advance_notice_days INT DEFAULT 1,
            description TEXT,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    const leaveTypes = [
        {
            leave_name: 'Cuti Tahunan',
            max_days_per_year: 12,
            requires_approval: true,
            requires_document: false,
            advance_notice_days: 3,
            description: 'Cuti tahunan reguler, maksimal 12 hari per tahun'
        },
        {
            leave_name: 'Sakit',
            max_days_per_year: 30,
            requires_approval: false,
            requires_document: true,
            advance_notice_days: 0,
            description: 'Cuti sakit dengan surat dokter untuk lebih dari 2 hari'
        },
        {
            leave_name: 'Darurat Keluarga',
            max_days_per_year: 5,
            requires_approval: true,
            requires_document: false,
            advance_notice_days: 0,
            description: 'Cuti darurat untuk keperluan keluarga mendesak'
        },
        {
            leave_name: 'Melahirkan',
            max_days_per_year: 90,
            requires_approval: true,
            requires_document: true,
            advance_notice_days: 30,
            description: 'Cuti melahirkan sesuai peraturan pemerintah'
        },
        {
            leave_name: 'Ibadah',
            max_days_per_year: 7,
            requires_approval: true,
            requires_document: false,
            advance_notice_days: 7,
            description: 'Cuti untuk keperluan ibadah keagamaan'
        }
    ];
    
    for (const leave of leaveTypes) {
        await connection.execute(`
            INSERT IGNORE INTO leave_types 
            (leave_name, max_days_per_year, requires_approval, requires_document, advance_notice_days, description) 
            VALUES (?, ?, ?, ?, ?, ?)
        `, [
            leave.leave_name,
            leave.max_days_per_year,
            leave.requires_approval,
            leave.requires_document,
            leave.advance_notice_days,
            leave.description
        ]);
    }
    
    console.log('   ✅ 5 leave types configured');
}

async function setupPenaltySystem(connection) {
    console.log('⚠️ Setting up penalty system...');
    
    await connection.execute(`
        CREATE TABLE IF NOT EXISTS penalty_rules (
            id INT AUTO_INCREMENT PRIMARY KEY,
            violation_type VARCHAR(50) NOT NULL,
            violation_count INT NOT NULL,
            penalty_action VARCHAR(100) NOT NULL,
            penalty_description TEXT,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    const penalties = [
        {
            violation_type: 'late_arrival',
            violation_count: 3,
            penalty_action: 'verbal_warning',
            penalty_description: 'Teguran lisan untuk 3x terlambat dalam sebulan'
        },
        {
            violation_type: 'late_arrival',
            violation_count: 5,
            penalty_action: 'written_warning',
            penalty_description: 'Surat peringatan tertulis untuk 5x terlambat dalam sebulan'
        },
        {
            violation_type: 'late_arrival',
            violation_count: 8,
            penalty_action: 'salary_deduction',
            penalty_description: 'Pemotongan gaji 1 hari untuk 8x terlambat dalam sebulan'
        },
        {
            violation_type: 'absent_without_notice',
            violation_count: 1,
            penalty_action: 'written_warning',
            penalty_description: 'Surat peringatan untuk tidak masuk tanpa keterangan'
        },
        {
            violation_type: 'absent_without_notice',
            violation_count: 3,
            penalty_action: 'suspension',
            penalty_description: 'Skorsing 3 hari untuk 3x tidak masuk tanpa keterangan'
        },
        {
            violation_type: 'early_checkout',
            violation_count: 3,
            penalty_action: 'verbal_warning',
            penalty_description: 'Teguran lisan untuk 3x pulang lebih awal tanpa izin'
        }
    ];
    
    for (const penalty of penalties) {
        await connection.execute(`
            INSERT IGNORE INTO penalty_rules 
            (violation_type, violation_count, penalty_action, penalty_description) 
            VALUES (?, ?, ?, ?)
        `, [
            penalty.violation_type,
            penalty.violation_count,
            penalty.penalty_action,
            penalty.penalty_description
        ]);
    }
    
    console.log('   ✅ Penalty system configured');
}

async function setupOvertimeRules(connection) {
    console.log('⏰ Setting up overtime rules...');
    
    await connection.execute(`
        CREATE TABLE IF NOT EXISTS overtime_rules (
            id INT AUTO_INCREMENT PRIMARY KEY,
            rule_name VARCHAR(50) NOT NULL,
            day_type ENUM('weekday', 'weekend', 'holiday') NOT NULL,
            overtime_rate DECIMAL(3,2) DEFAULT 1.5,
            minimum_overtime_minutes INT DEFAULT 30,
            maximum_overtime_hours INT DEFAULT 4,
            requires_approval BOOLEAN DEFAULT TRUE,
            description TEXT,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    const overtimeRules = [
        {
            rule_name: 'Weekday Overtime',
            day_type: 'weekday',
            overtime_rate: 1.5,
            minimum_overtime_minutes: 30,
            maximum_overtime_hours: 4,
            requires_approval: true,
            description: 'Overtime di hari kerja biasa dengan rate 1.5x'
        },
        {
            rule_name: 'Weekend Overtime',
            day_type: 'weekend',
            overtime_rate: 2.0,
            minimum_overtime_minutes: 30,
            maximum_overtime_hours: 6,
            requires_approval: true,
            description: 'Overtime di weekend dengan rate 2x'
        },
        {
            rule_name: 'Holiday Overtime',
            day_type: 'holiday',
            overtime_rate: 3.0,
            minimum_overtime_minutes: 30,
            maximum_overtime_hours: 8,
            requires_approval: true,
            description: 'Overtime di hari libur nasional dengan rate 3x'
        }
    ];
    
    for (const rule of overtimeRules) {
        await connection.execute(`
            INSERT IGNORE INTO overtime_rules 
            (rule_name, day_type, overtime_rate, minimum_overtime_minutes, maximum_overtime_hours, requires_approval, description) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            rule.rule_name,
            rule.day_type,
            rule.overtime_rate,
            rule.minimum_overtime_minutes,
            rule.maximum_overtime_hours,
            rule.requires_approval,
            rule.description
        ]);
    }
    
    console.log('   ✅ Overtime rules configured');
}

async function setupHolidayCalendar(connection) {
    console.log('📅 Setting up holiday calendar...');
    
    await connection.execute(`
        CREATE TABLE IF NOT EXISTS holidays (
            id INT AUTO_INCREMENT PRIMARY KEY,
            holiday_name VARCHAR(100) NOT NULL,
            holiday_date DATE NOT NULL,
            holiday_type ENUM('national', 'religious', 'company') DEFAULT 'national',
            is_working_day BOOLEAN DEFAULT FALSE,
            description TEXT,
            year INT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY unique_holiday_date (holiday_date)
        )
    `);
    
    // Hari libur nasional Indonesia 2024
    const holidays2024 = [
        {
            holiday_name: 'Tahun Baru',
            holiday_date: '2024-01-01',
            holiday_type: 'national',
            description: 'Tahun Baru Masehi'
        },
        {
            holiday_name: 'Isra Miraj',
            holiday_date: '2024-02-08',
            holiday_type: 'religious',
            description: 'Isra Miraj Nabi Muhammad SAW'
        },
        {
            holiday_name: 'Tahun Baru Imlek',
            holiday_date: '2024-02-10',
            holiday_type: 'religious',
            description: 'Tahun Baru Imlek 2575'
        },
        {
            holiday_name: 'Hari Raya Nyepi',
            holiday_date: '2024-03-11',
            holiday_type: 'religious',
            description: 'Hari Raya Nyepi Tahun Saka 1946'
        },
        {
            holiday_name: 'Wafat Isa Almasih',
            holiday_date: '2024-03-29',
            holiday_type: 'religious',
            description: 'Wafat Isa Almasih'
        },
        {
            holiday_name: 'Hari Buruh',
            holiday_date: '2024-05-01',
            holiday_type: 'national',
            description: 'Hari Buruh Internasional'
        },
        {
            holiday_name: 'Kenaikan Isa Almasih',
            holiday_date: '2024-05-09',
            holiday_type: 'religious',
            description: 'Kenaikan Isa Almasih'
        },
        {
            holiday_name: 'Hari Raya Waisak',
            holiday_date: '2024-05-23',
            holiday_type: 'religious',
            description: 'Hari Raya Waisak 2568'
        },
        {
            holiday_name: 'Pancasila',
            holiday_date: '2024-06-01',
            holiday_type: 'national',
            description: 'Hari Lahir Pancasila'
        },
        {
            holiday_name: 'Idul Fitri',
            holiday_date: '2024-04-10',
            holiday_type: 'religious',
            description: 'Hari Raya Idul Fitri 1445 H'
        },
        {
            holiday_name: 'Idul Fitri',
            holiday_date: '2024-04-11',
            holiday_type: 'religious',
            description: 'Hari Raya Idul Fitri 1445 H'
        },
        {
            holiday_name: 'Kemerdekaan RI',
            holiday_date: '2024-08-17',
            holiday_type: 'national',
            description: 'Hari Kemerdekaan Republik Indonesia'
        },
        {
            holiday_name: 'Idul Adha',
            holiday_date: '2024-06-17',
            holiday_type: 'religious',
            description: 'Hari Raya Idul Adha 1445 H'
        },
        {
            holiday_name: 'Tahun Baru Islam',
            holiday_date: '2024-07-07',
            holiday_type: 'religious',
            description: 'Tahun Baru Islam 1446 H'
        },
        {
            holiday_name: 'Maulid Nabi',
            holiday_date: '2024-09-16',
            holiday_type: 'religious',
            description: 'Maulid Nabi Muhammad SAW'
        },
        {
            holiday_name: 'Hari Natal',
            holiday_date: '2024-12-25',
            holiday_type: 'religious',
            description: 'Hari Raya Natal'
        }
    ];
    
    for (const holiday of holidays2024) {
        await connection.execute(`
            INSERT IGNORE INTO holidays 
            (holiday_name, holiday_date, holiday_type, description, year) 
            VALUES (?, ?, ?, ?, 2024)
        `, [
            holiday.holiday_name,
            holiday.holiday_date,
            holiday.holiday_type,
            holiday.description
        ]);
    }
    
    console.log('   ✅ 2024 holiday calendar configured');
}

// Run setup if called directly
if (require.main === module) {
    setupAttendancePolicies();
}

module.exports = { setupAttendancePolicies };