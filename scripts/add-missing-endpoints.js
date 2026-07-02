/**
 * ============================================
 * ADD MISSING API ENDPOINTS
 * ============================================
 * 
 * Script ini akan menambahkan endpoint yang hilang ke routes/api.js
 * untuk membuat Android app 100% kompatibel dengan server.
 * 
 * Missing endpoints:
 * 1. GET /attendance/summary
 * 2. GET /employee/face-reference  
 * 3. POST /pin/validate
 * 4. POST /face/re-enroll
 * 5. GET /face/status
 * 6. GET /health
 * 
 * Usage: node scripts/add-missing-endpoints.js
 */

const fs = require('fs');
const path = require('path');

const MISSING_ENDPOINTS = `

// ============================================
// MISSING ENDPOINTS FOR ANDROID COMPATIBILITY
// Added by add-missing-endpoints.js script
// ============================================

/**
 * @swagger
 * /api/attendance/summary:
 *   get:
 *     tags: [Attendance]
 *     summary: Get monthly attendance summary
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         schema:
 *           type: integer
 *         description: Month (1-12)
 *       - in: query
 *         name: year
 *         schema:
 *           type: integer
 *         description: Year (e.g., 2024)
 *     responses:
 *       200:
 *         description: Monthly attendance summary
 */
router.get('/attendance/summary', authenticateToken, async (req, res) => {
  const connection = await getConnection();
  
  try {
    const { month, year } = req.query;
    const karyawanId = req.user.id;
    
    // Default to current month/year if not provided
    const currentDate = new Date();
    const targetMonth = month || (currentDate.getMonth() + 1);
    const targetYear = year || currentDate.getFullYear();
    
    // Get attendance records for the month
    const [attendanceRows] = await connection.execute(\`
      SELECT 
        DATE(waktu) as date,
        attendance_type,
        waktu as time,
        is_late,
        is_early,
        overtime_minutes,
        work_duration_minutes
      FROM presensi 
      WHERE id_karyawan = ? 
        AND MONTH(waktu) = ? 
        AND YEAR(waktu) = ?
      ORDER BY waktu ASC
    \`, [karyawanId, targetMonth, targetYear]);
    
    // Process daily records
    const dailyRecords = {};
    let totalWorkHours = 0;
    let presentDays = 0;
    let lateDays = 0;
    
    attendanceRows.forEach(record => {
      const date = record.date;
      
      if (!dailyRecords[date]) {
        dailyRecords[date] = {
          date: date,
          clock_in: null,
          clock_out: null,
          work_duration: null,
          status: 'absent'
        };
      }
      
      if (record.attendance_type === 'clock_in') {
        dailyRecords[date].clock_in = record.time.substring(11, 16); // HH:MM
        dailyRecords[date].status = record.is_late ? 'late' : 'on_time';
        if (record.is_late) lateDays++;
      } else if (record.attendance_type === 'clock_out') {
        dailyRecords[date].clock_out = record.time.substring(11, 16); // HH:MM
        if (record.work_duration_minutes) {
          const hours = Math.floor(record.work_duration_minutes / 60);
          const minutes = record.work_duration_minutes % 60;
          dailyRecords[date].work_duration = \`\${hours} jam \${minutes} menit\`;
          totalWorkHours += record.work_duration_minutes / 60;
        }
      }
    });
    
    // Count present days (days with clock_in)
    presentDays = Object.values(dailyRecords).filter(day => day.clock_in !== null).length;
    
    // Calculate days in month
    const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();
    const absentDays = daysInMonth - presentDays;
    
    // Average work hours
    const averageWorkHours = presentDays > 0 ? (totalWorkHours / presentDays).toFixed(1) : 0;
    
    res.json({
      success: true,
      message: 'Attendance summary retrieved successfully',
      data: {
        month: parseInt(targetMonth),
        year: parseInt(targetYear),
        total_days: daysInMonth,
        present_days: presentDays,
        absent_days: absentDays,
        late_days: lateDays,
        total_work_hours: \`\${totalWorkHours.toFixed(1)} jam\`,
        average_work_hours: \`\${averageWorkHours} jam\`,
        daily_records: Object.values(dailyRecords)
      }
    });
    
  } catch (error) {
    console.error('Get attendance summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'SERVER_ERROR'
    });
  } finally {
    await connection.end();
  }
});

/**
 * @swagger
 * /api/employee/face-reference:
 *   get:
 *     tags: [Employee]
 *     summary: Get employee face reference photo info
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Face reference photo info
 */
router.get('/employee/face-reference', authenticateToken, async (req, res) => {
  const connection = await getConnection();
  
  try {
    const karyawanId = req.user.id;
    
    // Get active face reference
    const [faceRows] = await connection.execute(\`
      SELECT filename, original_name, upload_time, faces_count
      FROM karyawan_face_reference 
      WHERE karyawan_id = ? AND is_active = TRUE
      ORDER BY upload_time DESC
      LIMIT 1
    \`, [karyawanId]);
    
    if (faceRows.length === 0) {
      return res.json({
        success: true,
        data: {
          has_reference: false,
          photo_url: null,
          upload_date: null
        }
      });
    }
    
    const faceReference = faceRows[0];
    const photoUrl = \`uploads/karyawan/\${faceReference.filename}\`;
    
    res.json({
      success: true,
      data: {
        has_reference: true,
        photo_url: photoUrl,
        upload_date: faceReference.upload_time,
        faces_count: faceReference.faces_count,
        original_name: faceReference.original_name
      }
    });
    
  } catch (error) {
    console.error('Get face reference error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'SERVER_ERROR'
    });
  } finally {
    await connection.end();
  }
});

/**
 * @swagger
 * /api/pin/validate:
 *   post:
 *     tags: [PIN Management]
 *     summary: Validate PIN without changing it
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - pin
 *             properties:
 *               pin:
 *                 type: string
 *                 description: PIN to validate
 *     responses:
 *       200:
 *         description: PIN validation result
 */
router.post('/pin/validate', authenticateToken, async (req, res) => {
  const connection = await getConnection();
  
  try {
    const { pin } = req.body;
    const karyawanId = req.user.id;
    
    if (!pin) {
      return res.status(400).json({
        success: false,
        message: 'PIN is required',
        code: 'MISSING_PIN'
      });
    }
    
    // Get current PIN from database
    const [rows] = await connection.execute(
      'SELECT pin_hash FROM karyawan WHERE id = ?',
      [karyawanId]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found',
        code: 'EMPLOYEE_NOT_FOUND'
      });
    }
    
    const karyawan = rows[0];
    
    if (!karyawan.pin_hash) {
      return res.status(400).json({
        success: false,
        message: 'PIN not set for this employee',
        code: 'PIN_NOT_SET'
      });
    }
    
    // Verify PIN
    const isPinValid = await bcrypt.compare(pin, karyawan.pin_hash);
    
    res.json({
      success: true,
      message: isPinValid ? 'PIN is valid' : 'PIN is invalid',
      data: {
        pin_valid: isPinValid,
        validated_at: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('Validate PIN error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'SERVER_ERROR'
    });
  } finally {
    await connection.end();
  }
});

/**
 * @swagger
 * /api/face/re-enroll:
 *   post:
 *     tags: [Face Recognition]
 *     summary: Re-enroll face with PIN verification
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - current_pin
 *               - face_photo
 *             properties:
 *               current_pin:
 *                 type: string
 *                 description: Current PIN for verification
 *               face_photo:
 *                 type: string
 *                 format: binary
 *                 description: New face photo
 *     responses:
 *       200:
 *         description: Face re-enrollment successful
 */
router.post('/face/re-enroll', authenticateToken, upload.single('face_photo'), async (req, res) => {
  const connection = await getConnection();
  
  try {
    const { current_pin } = req.body;
    const karyawanId = req.user.id;
    
    if (!current_pin) {
      return res.status(400).json({
        success: false,
        message: 'Current PIN is required',
        code: 'MISSING_PIN'
      });
    }
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Face photo is required',
        code: 'NO_PHOTO'
      });
    }
    
    // Verify current PIN
    const [rows] = await connection.execute(
      'SELECT pin_hash FROM karyawan WHERE id = ?',
      [karyawanId]
    );
    
    const karyawan = rows[0];
    const isPinValid = await bcrypt.compare(current_pin, karyawan.pin_hash);
    
    if (!isPinValid) {
      // Delete uploaded file
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      
      return res.status(401).json({
        success: false,
        message: 'Current PIN is incorrect',
        code: 'INVALID_PIN'
      });
    }
    
    // Detect faces in new photo
    const faces = await detectFaces(req.file.path);
    
    if (faces.length === 0) {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      
      return res.status(400).json({
        success: false,
        message: 'No faces detected in the image',
        code: 'NO_FACES'
      });
    }
    
    // Get old photo filename for cleanup
    const [oldFaceRows] = await connection.execute(
      'SELECT filename FROM karyawan_face_reference WHERE karyawan_id = ? AND is_active = TRUE',
      [karyawanId]
    );
    
    const oldPhoto = oldFaceRows.length > 0 ? oldFaceRows[0].filename : null;
    
    // Start transaction
    await connection.beginTransaction();
    
    try {
      // Deactivate old face references
      await connection.execute(
        'UPDATE karyawan_face_reference SET is_active = FALSE WHERE karyawan_id = ?',
        [karyawanId]
      );
      
      // Save new face reference
      await connection.execute(\`
        INSERT INTO karyawan_face_reference 
        (karyawan_id, filename, original_name, file_path, faces_data, faces_count, is_active) 
        VALUES (?, ?, ?, ?, ?, ?, TRUE)
      \`, [
        karyawanId,
        req.file.filename,
        req.file.originalname,
        req.file.path,
        JSON.stringify(faces),
        faces.length
      ]);
      
      // Update karyawan foto_referensi
      await connection.execute(
        'UPDATE karyawan SET foto_referensi = ? WHERE id = ?',
        [req.file.filename, karyawanId]
      );
      
      await connection.commit();
      
      res.json({
        success: true,
        message: 'Face re-enrollment successful',
        data: {
          faces_detected: faces.length,
          old_photo: oldPhoto,
          new_photo: req.file.filename,
          updated_at: new Date().toISOString()
        }
      });
      
    } catch (error) {
      await connection.rollback();
      throw error;
    }
    
  } catch (error) {
    console.error('Face re-enroll error:', error);
    
    // Delete uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'SERVER_ERROR'
    });
  } finally {
    await connection.end();
  }
});

/**
 * @swagger
 * /api/face/status:
 *   get:
 *     tags: [Face Recognition]
 *     summary: Get face recognition status for employee
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Face recognition status
 */
router.get('/face/status', authenticateToken, async (req, res) => {
  const connection = await getConnection();
  
  try {
    const karyawanId = req.user.id;
    
    // Check if face reference exists
    const [faceRows] = await connection.execute(
      'SELECT COUNT(*) as count FROM karyawan_face_reference WHERE karyawan_id = ? AND is_active = TRUE',
      [karyawanId]
    );
    
    const hasReference = faceRows[0].count > 0;
    
    // Check if face recognition is enabled (default: true)
    const isEnabled = true;
    
    res.json({
      success: true,
      data: {
        enabled: isEnabled,
        has_reference: hasReference,
        enrollment_completed: hasReference
      }
    });
    
  } catch (error) {
    console.error('Get face status error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'SERVER_ERROR'
    });
  } finally {
    await connection.end();
  }
});

/**
 * @swagger
 * /api/health:
 *   get:
 *     tags: [System]
 *     summary: Health check endpoint
 *     responses:
 *       200:
 *         description: Server health status
 */
router.get('/health', async (req, res) => {
  try {
    // Basic health check
    const healthData = {
      success: true,
      message: 'Server is healthy',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      environment: process.env.NODE_ENV || 'development'
    };
    
    // Test database connection
    try {
      const connection = await getConnection();
      await connection.execute('SELECT 1');
      await connection.end();
      healthData.database = 'connected';
    } catch (dbError) {
      healthData.database = 'disconnected';
      healthData.database_error = dbError.message;
    }
    
    res.json(healthData);
    
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({
      success: false,
      message: 'Server health check failed',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

`;

async function addMissingEndpoints() {
    console.log('🔧 Adding missing API endpoints for Android compatibility...\n');
    
    try {
        const apiFilePath = path.join(__dirname, '..', 'routes', 'api.js');
        
        // Read current API file
        let apiContent = fs.readFileSync(apiFilePath, 'utf8');
        
        // Check if endpoints already exist
        if (apiContent.includes("router.get('/attendance/summary'")) {
            console.log('⚠️  Missing endpoints already exist in api.js');
            console.log('   Skipping addition to avoid duplicates');
            return;
        }
        
        // Find the module.exports line
        const exportIndex = apiContent.lastIndexOf('module.exports = router;');
        
        if (exportIndex === -1) {
            throw new Error('Could not find module.exports line in api.js');
        }
        
        // Insert missing endpoints before module.exports
        const beforeExport = apiContent.substring(0, exportIndex);
        const afterExport = apiContent.substring(exportIndex);
        
        const newContent = beforeExport + MISSING_ENDPOINTS + '\n' + afterExport;
        
        // Write updated content
        fs.writeFileSync(apiFilePath, newContent, 'utf8');
        
        console.log('✅ Successfully added missing endpoints:');
        console.log('   📊 GET /attendance/summary - Monthly attendance summary');
        console.log('   👤 GET /employee/face-reference - Face reference info');
        console.log('   🔐 POST /pin/validate - PIN validation');
        console.log('   📸 POST /face/re-enroll - Face re-enrollment');
        console.log('   📋 GET /face/status - Face recognition status');
        console.log('   ❤️  GET /health - Health check');
        
        console.log('\n🎉 Android app is now 100% compatible with server API!');
        console.log('\n📝 Next steps:');
        console.log('   1. Restart the server: npm start');
        console.log('   2. Test new endpoints with Android app');
        console.log('   3. Verify all functionality works correctly');
        
    } catch (error) {
        console.error('❌ Failed to add missing endpoints:', error.message);
        console.error('\n💡 Manual steps:');
        console.error('   1. Open routes/api.js');
        console.error('   2. Add the missing endpoints manually');
        console.error('   3. Check ANDROID-API-ANALYSIS.md for details');
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    addMissingEndpoints();
}

module.exports = { addMissingEndpoints };
