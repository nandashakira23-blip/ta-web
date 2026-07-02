require('dotenv').config();
const mysql = require('mysql2/promise');

async function checkOfficeLocation() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
  });

  try {
    console.log('Checking office location settings...\n');

    // Get all settings
    const [rows] = await connection.execute(
      'SELECT * FROM pengaturan'
    );

    console.log(`Found ${rows.length} rows in pengaturan table:\n`);
    
    rows.forEach((row, index) => {
      console.log(`Row ${index + 1}:`);
      console.log(`  ID: ${row.id}`);
      console.log(`  Nama Perusahaan: ${row.nama_perusahaan}`);
      console.log(`  Lokasi Kantor: ${row.lat_kantor}, ${row.long_kantor}`);
      console.log(`  Radius: ${row.radius_meter}m`);
      console.log(`  Alamat: ${row.alamat_kantor}`);
      console.log('');
    });

    // Check which one is used by LIMIT 1
    const [activeRow] = await connection.execute(
      'SELECT * FROM pengaturan LIMIT 1'
    );

    if (activeRow.length > 0) {
      console.log('Currently active setting (LIMIT 1):');
      console.log(`  ID: ${activeRow[0].id}`);
      console.log(`  Lokasi: ${activeRow[0].lat_kantor}, ${activeRow[0].long_kantor}`);
      console.log(`  Radius: ${activeRow[0].radius_meter}m`);
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await connection.end();
  }
}

checkOfficeLocation();
