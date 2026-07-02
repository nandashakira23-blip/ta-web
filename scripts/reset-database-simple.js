/**
 * Simple Database Reset
 * Drop all tables and run migrations
 */

require('dotenv').config();
const { execSync } = require('child_process');

console.log('');
console.log('=== DATABASE RESET ===');
console.log('');

try {
    // Step 1: Drop all tables using migrate:down
    console.log('Step 1: Dropping all tables...');
    try {
        execSync('node scripts/migrate.js down', { stdio: 'inherit' });
    } catch (e) {
        console.log('(No tables to drop or already clean)');
    }
    
    // Step 2: Run all migrations
    console.log('');
    console.log('Step 2: Running all migrations...');
    execSync('node scripts/migrate.js up', { stdio: 'inherit' });
    
    console.log('');
    console.log('✅ Database reset completed!');
    console.log('');
    
} catch (error) {
    console.error('');
    console.error('❌ Error:', error.message);
    console.error('');
    process.exit(1);
}
