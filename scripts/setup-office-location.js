const mysql = require('mysql2/promise');

// Database configuration
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'presensi_fleur_atelier'
};

async function setupOfficeLocations() {
  let connection;
  
  try {
    console.log('Connecting to MySQL database...');
    connection = await mysql.createConnection(dbConfig);
    
    // FLEUR CAFÉ realistic office locations in Jakarta
    const officeLocations = [
      {
        name: 'FLEUR CAFÉ Kemang',
        latitude: -6.2615,
        longitude: 106.8106,
        radius: 50, // 50 meters
        address: 'Jl. Kemang Raya No. 12, Jakarta Selatan'
      },
      {
        name: 'FLEUR CAFÉ Senopati',
        latitude: -6.2297,
        longitude: 106.8081,
        radius: 75, // 75 meters
        address: 'Jl. Senopati No. 45, Jakarta Selatan'
      },
      {
        name: 'FLEUR CAFÉ PIK',
        latitude: -6.1088,
        longitude: 106.7378,
        radius: 100, // 100 meters
        address: 'Pantai Indah Kapuk, Jakarta Utara'
      },
      {
        name: 'FLEUR CAFÉ Bali',
        latitude: -8.6705,
        longitude: 115.2126,
        radius: 60, // 60 meters
        address: 'Jl. Sunset Road, Seminyak, Bali'
      }
    ];
    
    console.log('Setting up office locations...');
    
    // For this demo, we'll use the first location (Kemang)
    const mainOffice = officeLocations[0];
    
    // Check if pengaturan table exists and has data
    const [existingSettings] = await connection.execute(
      'SELECT COUNT(*) as count FROM pengaturan'
    );
    
    if (existingSettings[0].count === 0) {
      // Insert new settings
      await connection.execute(`
        INSERT INTO pengaturan (
          lat_kantor, 
          long_kantor, 
          radius_meter, 
          created_at,
          updated_at
        ) VALUES (?, ?, ?, NOW(), NOW())
      `, [
        mainOffice.latitude,
        mainOffice.longitude,
        mainOffice.radius
      ]);
      
      console.log(`✓ Office location created: ${mainOffice.name}`);
    } else {
      // Update existing settings
      await connection.execute(`
        UPDATE pengaturan 
        SET lat_kantor = ?, 
            long_kantor = ?, 
            radius_meter = ?,
            updated_at = NOW()
        LIMIT 1
      `, [
        mainOffice.latitude,
        mainOffice.longitude,
        mainOffice.radius
      ]);
      
      console.log(`✓ Office location updated: ${mainOffice.name}`);
    }
    
    // Display current office location settings
    const [currentSettings] = await connection.execute(
      'SELECT lat_kantor, long_kantor, radius_meter FROM pengaturan LIMIT 1'
    );
    
    if (currentSettings.length > 0) {
      const settings = currentSettings[0];
      console.log('\n=== CURRENT OFFICE LOCATION ===');
      console.log(`Name: ${mainOffice.name}`);
      console.log(`Address: ${mainOffice.address}`);
      console.log(`Latitude: ${settings.lat_kantor}`);
      console.log(`Longitude: ${settings.long_kantor}`);
      console.log(`Radius: ${settings.radius_meter} meters`);
      console.log('================================\n');
    }
    
    // Show all available locations for reference
    console.log('=== AVAILABLE OFFICE LOCATIONS ===');
    officeLocations.forEach((location, index) => {
      console.log(`${index + 1}. ${location.name}`);
      console.log(`   Address: ${location.address}`);
      console.log(`   Coordinates: ${location.latitude}, ${location.longitude}`);
      console.log(`   Radius: ${location.radius}m`);
      console.log('');
    });
    
    console.log('✓ Office location setup completed successfully!');
    
  } catch (error) {
    console.error('Error setting up office locations:', error);
    throw error;
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

// Run the setup
if (require.main === module) {
  setupOfficeLocations()
    .then(() => {
      console.log('Office location setup finished.');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Setup failed:', error);
      process.exit(1);
    });
}

module.exports = { setupOfficeLocations };