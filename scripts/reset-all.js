/**
 * Script untuk reset SEMUA data dan foto
 * Kombinasi dari clear-database.js dan clean-photos.js
 * 
 * Script ini akan:
 * 1. Backup database (opsional)
 * 2. Clear semua data di database
 * 3. Clean semua foto
 * 4. Reset admin password
 * 
 * PERINGATAN: Ini akan menghapus SEMUA data dan foto!
 */

const { execSync } = require('child_process');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('==============================================');
console.log('⚠️  RESET ALL - DATABASE & PHOTOS');
console.log('==============================================');
console.log('Script ini akan:');
console.log('  1. Backup database (opsional)');
console.log('  2. Clear SEMUA data di database');
console.log('  3. Clean SEMUA foto');
console.log('  4. Reset admin password');
console.log('==============================================\n');

// Ask for confirmation
rl.question('Apakah Anda yakin ingin melanjutkan? (yes/no): ', (answer) => {
  if (answer.toLowerCase() !== 'yes') {
    console.log('\n❌ Reset dibatalkan');
    rl.close();
    process.exit(0);
  }

  rl.question('\nApakah Anda ingin backup database dulu? (yes/no): ', (backupAnswer) => {
    rl.close();

    console.log('\n==============================================');
    console.log('STARTING RESET PROCESS');
    console.log('==============================================\n');

    try {
      // Step 1: Backup (optional)
      if (backupAnswer.toLowerCase() === 'yes') {
        console.log('Step 1: Creating backup...');
        execSync('node scripts/backup-database.js', { stdio: 'inherit' });
        console.log('✅ Backup completed\n');
      } else {
        console.log('Step 1: Skipping backup...\n');
      }

      // Step 2: Clear database
      console.log('Step 2: Clearing database...');
      execSync('node scripts/clear-database.js', { stdio: 'inherit' });
      console.log('✅ Database cleared\n');

      // Step 3: Clean photos
      console.log('Step 3: Cleaning photos...');
      execSync('node scripts/clean-photos.js', { stdio: 'inherit' });
      console.log('✅ Photos cleaned\n');

      console.log('==============================================');
      console.log('RESET COMPLETED SUCCESSFULLY!');
      console.log('==============================================');
      console.log('\nYour system is now reset to initial state:');
      console.log('  ✅ Database cleared (admin user preserved)');
      console.log('  ✅ All photos deleted');
      console.log('  ✅ Admin login: admin / admin123');
      console.log('\nReady for fresh data!');
      console.log('==============================================\n');

    } catch (error) {
      console.error('\n❌ Error during reset:', error.message);
      process.exit(1);
    }
  });
});
