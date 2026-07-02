const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function backupDatabase() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const backupDir = path.join(__dirname, '..', 'backups');
    const backupFile = path.join(backupDir, `backup-${timestamp}.sql`);

    console.log('Starting database backup...');

    try {
        // Create backups directory if not exists
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        const connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
            database: process.env.DB_NAME
        });

        let backupContent = `-- Database Backup: ${process.env.DB_NAME}\n`;
        backupContent += `-- Created: ${new Date().toISOString()}\n\n`;
        backupContent += `USE ${process.env.DB_NAME};\n\n`;

        // Get all tables
        const [tables] = await connection.execute('SHOW TABLES');
        
        for (const tableRow of tables) {
            const tableName = Object.values(tableRow)[0];
            console.log(`Backing up table: ${tableName}`);

            // Get table structure
            const [createTable] = await connection.execute(`SHOW CREATE TABLE ${tableName}`);
            backupContent += `-- Table: ${tableName}\n`;
            backupContent += `DROP TABLE IF EXISTS ${tableName};\n`;
            backupContent += `${createTable[0]['Create Table']};\n\n`;

            // Get table data
            const [rows] = await connection.execute(`SELECT * FROM ${tableName}`);
            
            if (rows.length > 0) {
                backupContent += `-- Data for table: ${tableName}\n`;
                
                for (const row of rows) {
                    const values = Object.values(row).map(value => {
                        if (value === null) return 'NULL';
                        if (typeof value === 'string') return `'${value.replace(/'/g, "\\'")}'`;
                        if (value instanceof Date) return `'${value.toISOString().slice(0, 19).replace('T', ' ')}'`;
                        return value;
                    }).join(', ');
                    
                    const columns = Object.keys(row).join(', ');
                    backupContent += `INSERT INTO ${tableName} (${columns}) VALUES (${values});\n`;
                }
                backupContent += '\n';
            }
        }

        await connection.end();

        // Write backup file
        fs.writeFileSync(backupFile, backupContent);
        
        console.log('Database backup completed successfully!');
        console.log(`Backup saved to: ${backupFile}`);
        
        return backupFile;

    } catch (error) {
        console.error('Backup failed:', error.message);
        throw error;
    }
}

// Run if called directly
if (require.main === module) {
    backupDatabase();
}

module.exports = { backupDatabase };
