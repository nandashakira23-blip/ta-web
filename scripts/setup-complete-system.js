/**
 * ============================================
 * SETUP SISTEM LENGKAP FLEUR CAFÉ
 * ============================================
 * 
 * Setup lengkap sistem presensi yang realistis:
 * 1. MySQL Database
 * 2. Shift System
 * 3. Attendance Policies
 * 4. Missing Android Endpoints
 * 5. Sample Data
 * 
 * Usage: npm run setup:all
 */

const { setupMySQL } = require('./setup-mysql');
const { setupShiftSystem } = require('./setup-shift-system');
const { setupAttendancePolicies } = require('./setup-attendance-policies');
const { addMissingEndpoints } = require('./add-missing-endpoints');

async function setupCompleteSystem() {
    console.log('🏪 FLEUR CAFÉ - Complete System Setup');
    console.log('=====================================\n');
    
    try {
        // Phase 1: Database Setup
        console.log('📊 Phase 1: Setting up MySQL Database...');
        await setupMySQL();
        console.log('✅ Database setup completed\n');
        
        // Phase 2: Shift System
        console.log('⏰ Phase 2: Setting up Shift System...');
        await setupShiftSystem();
        console.log('✅ Shift system setup completed\n');
        
        // Phase 3: Attendance Policies
        console.log('📋 Phase 3: Setting up Attendance Policies...');
        await setupAttendancePolicies();
        console.log('✅ Attendance policies setup completed\n');
        
        // Phase 4: Android Endpoints
        console.log('📱 Phase 4: Adding Android Endpoints...');
        await addMissingEndpoints();
        console.log('✅ Android endpoints added\n');
        
        // Final Summary
        console.log('🎉 SETUP COMPLETED SUCCESSFULLY!');
        console.log('================================\n');
        
        console.log('📋 System Summary:');
        console.log('   Database: MySQL with 15+ tables');
        console.log('   Shifts: 5 realistic work schedules');
        console.log('   Employees: 8 sample employees');
        console.log('   Policies: Complete attendance rules');
        console.log('   API: 26 endpoints (100% Android compatible)');
        console.log('   Security: PIN + Face recognition + JWT');
        
        console.log('\n🏪 FLEUR CAFÉ Shift Schedule:');
        console.log('   🌅 Morning Shift: 06:00-14:00 (Opening crew)');
        console.log('   ☀️  Day Shift: 09:00-17:00 (Peak hours)');
        console.log('   🌙 Evening Shift: 14:00-22:00 (Closing crew)');
        console.log('   🎉 Weekend Shift: 08:00-20:00 (Weekend)');
        console.log('   🎊 Holiday Shift: 10:00-18:00 (Holidays)');
        
        console.log('\n👥 Sample Employees:');
        console.log('   FLEUR001 - Sarah Manager (Store Manager)');
        console.log('   FLEUR002 - David Assistant (Assistant Manager)');
        console.log('   FLEUR003 - Maya Barista (Head Barista)');
        console.log('   FLEUR004 - Andi Coffee (Barista)');
        console.log('   FLEUR005 - Lisa Cashier (Cashier)');
        console.log('   FLEUR006 - Rudi Kitchen (Kitchen Staff)');
        console.log('   FLEUR007 - Nina Server (Server/Waitress)');
        console.log('   FLEUR008 - Budi Cleaning (Cleaning Staff)');
        
        console.log('\n📱 Android App Features:');
        console.log('   ✅ Employee activation with NIK + PIN + Face');
        console.log('   ✅ Check-in/out with GPS + Face recognition');
        console.log('   ✅ Real-time location validation (50m radius)');
        console.log('   ✅ Work schedule integration');
        console.log('   ✅ Overtime calculation');
        console.log('   ✅ Attendance history & summary');
        console.log('   ✅ Profile management');
        console.log('   ✅ PIN security with lockout');
        
        console.log('\n🚀 Next Steps:');
        console.log('   1. Start server: npm start');
        console.log('   2. Access admin: http://localhost:3000/admin');
        console.log('   3. Login: admin / admin123');
        console.log('   4. Test Android app with sample employees');
        console.log('   5. Activate employees using their NIK (FLEUR001-008)');
        
        console.log('\n📞 Employee Activation:');
        console.log('   - Use NIK: FLEUR001, FLEUR002, etc.');
        console.log('   - Set 4-digit PIN');
        console.log('   - Upload face photo');
        console.log('   - Start using attendance system');
        
    } catch (error) {
        console.error('❌ Setup failed:', error.message);
        console.error('\n🔧 Troubleshooting:');
        console.error('   1. Check MySQL server is running');
        console.error('   2. Verify .env database configuration');
        console.error('   3. Ensure proper MySQL permissions');
        console.error('   4. Check network connectivity');
        process.exit(1);
    }
}

// Run complete setup if called directly
if (require.main === module) {
    setupCompleteSystem();
}

module.exports = { setupCompleteSystem };