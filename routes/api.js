/**
 * ============================================
 * API ROUTES - ENDPOINT UNTUK APLIKASI MOBILE
 * ============================================
 * 
 * File ini berisi semua endpoint API untuk aplikasi Android.
 * Setiap endpoint sudah dilengkapi dengan Swagger documentation.
 * 
 * DAFTAR ENDPOINT:
 * 
 * AUTHENTICATION (Autentikasi):
 * - POST /api/auth/check-nik     : Cek apakah NIK terdaftar
 * - POST /api/auth/login         : Login dengan NIK + PIN
 * - POST /api/auth/activate      : Aktivasi akun baru (NIK + PIN + Foto wajah)
 * - POST /api/auth/logout        : Logout
 * - GET  /api/auth/profile/:id   : Ambil data profil karyawan
 * - PUT  /api/auth/profile/:id   : Update profil (email, phone, foto)
 * - POST /api/auth/refresh       : Refresh access token
 * 
 * ACTIVATION (Aktivasi Akun):
 * - POST /api/activation/upload-face : Upload foto wajah untuk referensi
 * - POST /api/activation/set-pin     : Set PIN untuk akun baru
 * - POST /api/activation/complete    : Selesaikan proses aktivasi
 * 
 * PIN MANAGEMENT:
 * - POST /api/pin/change         : Ganti PIN
 * 
 * PRESENSI:
 * - POST /api/attendance/checkin     : Clock in (masuk kerja)
 * - POST /api/attendance/break/start : Mulai istirahat
 * - POST /api/attendance/break/end   : Selesai istirahat dengan validasi lokasi
 * - POST /api/attendance/checkout    : Clock out (pulang kerja)
 * - GET  /api/attendance/status/:id  : Cek status presensi hari ini
 * - GET  /api/attendance/today       : Ambil data presensi hari ini
 * - GET  /api/attendance/history     : Ambil riwayat presensi
 * - POST /api/attendance/validate-face : Validasi wajah sebelum presensi
 * - GET  /api/replacement-candidates : Daftar karyawan yang bisa dipilih sebagai pengganti
 * 
 * SCHEDULE (Jadwal Kerja):
 * - GET /api/schedule/today/:id  : Ambil jadwal kerja hari ini
 * 
 * VALIDATION (Validasi):
 * - POST /api/validation/location   : Validasi lokasi (dalam radius kantor?)
 * - POST /api/validation/face-match : Validasi kecocokan wajah
 * 
 * SETTINGS (Pengaturan):
 * - GET /api/settings/office-location : Ambil lokasi kantor
 * 
 * ADMIN TEST (Testing - Development Only):
 * - POST /api/admin/test/upload-reference : Test upload foto referensi
 * - POST /api/admin/test/match-face       : Test pencocokan wajah
 * - POST /api/admin/test/realtime-match   : Test real-time matching
 * 
 * FACE DETECTION:
 * - POST /api/face/detect-realtime : Deteksi wajah real-time
 */

// ============================================
// IMPORT DEPENDENCIES
// ============================================

const express = require('express');
const multer = require('multer');       // Untuk handle file upload
const bcrypt = require('bcrypt');       // Untuk hash password/PIN
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { getMysqlConfig } = require('../config/mysql');

// Import utility functions
const { authenticateToken, generateAccessToken, generateRefreshToken, verifyRefreshToken } = require('../utils/jwt');
const { detectFaces, getProbeFaces, compareFaces } = require('../utils/face-recognition');
const { isLocationValid } = require('../utils/location');
const { apiLoggerMiddleware, logger } = require('../utils/api-logger');
const { generateVerificationToken, generateVerificationOtp, getVerificationExpiry, sendVerificationEmail } = require('../utils/email-verification');
const { calculateLeaveMinutes, calculateWorkSummary } = require('../utils/worktime');
const {
  createUploadStorage,
  deleteStoredFile,
  discardUploadedFile,
  persistUploadedFile
} = require('../utils/upload-storage');
const packageInfo = require('../package.json');

// Buat router Express
const router = express.Router();

// Pasang middleware logging untuk semua API routes
router.use(apiLoggerMiddleware);

const DEFAULT_BREAK_ALLOWANCE_MINUTES = 60;

/**
 * @swagger
 * /api/health:
 *   get:
 *     tags: [System]
 *     summary: Health check service dan koneksi database
 *     responses:
 *       200:
 *         description: Service dalam kondisi sehat
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Service is healthy
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 version:
 *                   type: string
 *                   example: 1.0.0
 *                 environment:
 *                   type: string
 *                   example: production
 *       503:
 *         description: Service unavailable
 */
router.get('/health', async (req, res) => {
  let connection;

  try {
    connection = await getConnection();
    await connection.ping();

    return res.json({
      success: true,
      message: 'Service is healthy',
      timestamp: new Date().toISOString(),
      version: packageInfo.version,
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (error) {
    return res.status(503).json({
      success: false,
      message: 'Service unavailable',
      timestamp: new Date().toISOString(),
      version: packageInfo.version,
      code: 'SERVICE_UNAVAILABLE'
    });
  } finally {
    if (connection) {
      await connection.end();
    }
  }
});

async function checkDatabaseConnection() {
  let connection;

  try {
    connection = await getConnection();
    await connection.ping();

    const [dbRows] = await connection.execute(
      'SELECT DATABASE() AS database_name, CURRENT_USER() AS current_db_user, VERSION() AS version'
    );
    const [tableRows] = await connection.execute(
      'SELECT COUNT(*) AS table_count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()'
    );

    return {
      success: true,
      message: 'Database connection is healthy',
      timestamp: new Date().toISOString(),
      config: {
        host: process.env.DB_HOST || null,
        port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
        database: process.env.DB_NAME || null,
        user: process.env.DB_USER || null
      },
      database: {
        name: dbRows[0]?.database_name || null,
        currentUser: dbRows[0]?.current_db_user || null,
        version: dbRows[0]?.version || null,
        tableCount: tableRows[0]?.table_count ?? 0
      }
    };
  } catch (error) {
    return {
      success: false,
      message: 'Database connection failed',
      timestamp: new Date().toISOString(),
      config: {
        host: process.env.DB_HOST || null,
        port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
        database: process.env.DB_NAME || null,
        user: process.env.DB_USER || null
      },
      error: {
        code: error.code || null,
        errno: error.errno || null,
        syscall: error.syscall || null,
        address: error.address || null,
        port: error.port || null,
        message: error.message
      }
    };
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

/**
 * @swagger
 * /api/database:
 *   get:
 *     tags: [System]
 *     summary: Cek koneksi database MySQL dan info skema
 *     description: Ping MySQL, return info database aktif (nama, user, versi, jumlah tabel) plus konfigurasi koneksi. Tidak butuh autentikasi.
 *     responses:
 *       200:
 *         description: Koneksi database sehat
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Database connection is healthy
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 config:
 *                   type: object
 *                   properties:
 *                     host:
 *                       type: string
 *                       nullable: true
 *                     port:
 *                       type: integer
 *                       example: 3306
 *                     database:
 *                       type: string
 *                       nullable: true
 *                     user:
 *                       type: string
 *                       nullable: true
 *                 database:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                       nullable: true
 *                     currentUser:
 *                       type: string
 *                       nullable: true
 *                     version:
 *                       type: string
 *                       nullable: true
 *                       example: 8.0.36
 *                     tableCount:
 *                       type: integer
 *                       example: 11
 *       503:
 *         description: Koneksi database gagal
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: Database connection failed
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 config:
 *                   type: object
 *                 error:
 *                   type: object
 *                   properties:
 *                     code:
 *                       type: string
 *                       nullable: true
 *                     errno:
 *                       type: integer
 *                       nullable: true
 *                     syscall:
 *                       type: string
 *                       nullable: true
 *                     address:
 *                       type: string
 *                       nullable: true
 *                     port:
 *                       type: integer
 *                       nullable: true
 *                     message:
 *                       type: string
 */
router.get('/database', async (req, res) => {
  const result = await checkDatabaseConnection();
  return res.status(result.success ? 200 : 503).json(result);
});

// ============================================
// DATABASE CONNECTION
// ============================================

/**
 * Membuat koneksi baru ke database MySQL
 * Dipanggil di setiap request untuk menghindari connection pooling issues
 */
async function getConnection() {
  return await mysql.createConnection(getMysqlConfig());
}

/**
 * Catat percobaan verifikasi wajah yang GAGAL untuk data pengujian (/admin/testing).
 * Foto probe tetap disimpan; ini TIDAK membuat presensi menjadi valid.
 * status: 'no_match' (wajah beda/orang lain), 'no_face' (tak ada wajah), 'no_image' (tak ada gambar).
 * Aman dipanggil walau tabel belum ada — error ditelan agar tidak mengganggu alur absen.
 */
async function logFaceAttempt(connection, { idKaryawan = null, jenis = 'masuk', status, similarity = null, distance = null, file = null }) {
  try {
    let photoPath = null;
    if (file && file.path && fs.existsSync(file.path)) {
      try {
        photoPath = await persistUploadedFile(file, { folder: 'uploads/karyawan' });
      } catch (e) {
        console.warn('[logFaceAttempt] gagal menyimpan foto:', e.message);
      }
    }
    if (!idKaryawan) return photoPath;
    const num = (v) => (v === null || v === undefined || Number.isNaN(Number(v))) ? null : Number(v);
    const pct = (v) => (Math.round(Number(v) * 1000) / 10).toString().replace('.', ',');
    const simVal = num(similarity);
    const distVal = num(distance);
    const simThreshold = 1 - (Number(process.env.FACE_MATCH_DISTANCE) || 0.6);
    // Keterangan: no_match dibuat DINAMIS (sertakan kemiripan aktual + ambang); lainnya teks tetap.
    const keteranganMap = {
      no_match: (simVal !== null)
        ? `Wajah tidak cocok — kemiripan ${pct(simVal)}% (di bawah ambang ${pct(simThreshold)}%), kemungkinan orang lain`
        : 'Wajah tidak cocok dengan referensi (kemungkinan orang lain)',
      no_face: 'Tidak ada wajah terdeteksi pada foto',
      no_image: 'Tidak ada gambar yang dikirim'
    };
    const entry = {
      waktu: getCurrentDateTimeWITA(),
      jenis,
      status,
      similarity: simVal,
      distance: distVal,
      foto: photoPath,
      keterangan: keteranganMap[status] || null
    };
    // Simpan sebagai array JSON di kolom karyawan.data_percobaan_gagal (append atomik)
    await connection.execute(
      `UPDATE karyawan
       SET data_percobaan_gagal = JSON_ARRAY_APPEND(COALESCE(data_percobaan_gagal, JSON_ARRAY()), '$', CAST(? AS JSON))
       WHERE id = ?`,
      [JSON.stringify(entry), idKaryawan]
    );
    return photoPath;
  } catch (e) {
    console.error('[logFaceAttempt] gagal mencatat percobaan:', e.message);
    return null;
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get current time in WITA timezone (Asia/Makassar, UTC+8)
 * Returns time in HH:MM:SS format
 */
function getCurrentTimeWITA() {
  const now = new Date();
  // Convert to WITA (UTC+8)
  const witaTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Makassar' }));
  const hours = String(witaTime.getHours()).padStart(2, '0');
  const minutes = String(witaTime.getMinutes()).padStart(2, '0');
  const seconds = String(witaTime.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

/**
 * Get current date in WITA timezone
 * Returns date in YYYY-MM-DD format
 */
function getCurrentDateWITA() {
  const now = new Date();
  const witaTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Makassar' }));
  const year = witaTime.getFullYear();
  const month = String(witaTime.getMonth() + 1).padStart(2, '0');
  const day = String(witaTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Get current day name in WITA timezone
 * Returns day name in English (e.g., "Monday", "Tuesday")
 */
function getCurrentDayNameWITA() {
  const now = new Date();
  return now.toLocaleDateString('en-US', { 
    weekday: 'long',
    timeZone: 'Asia/Makassar'
  });
}

/**
 * Check if current time is within allowed time range
 * Handles overnight shift (e.g., 20:00 - 09:00)
 */
function isTimeInRange(currentTime, startTime, endTime) {
  if (!startTime || !endTime) return true;
  
  // Convert times to minutes for easier comparison
  const timeToMinutes = (timeStr) => {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
  };
  
  const current = timeToMinutes(currentTime);
  const start = timeToMinutes(startTime);
  const end = timeToMinutes(endTime);
  
  // If start time is less than end time (normal shift, e.g., 08:00 - 17:00)
  if (start <= end) {
    return current >= start && current <= end;
  }
  
  // If start time is greater than end time (overnight shift, e.g., 20:00 - 09:00)
  // Current time is valid if it's after start OR before end
  return current >= start || current <= end;
}

function addMinutesToTime(timeStr, minutesToAdd) {
  if (!timeStr) return timeStr;

  const [hours = 0, minutes = 0, seconds = 0] = String(timeStr).split(':').map(Number);
  const totalMinutes = (hours * 60) + minutes + minutesToAdd;
  const normalizedMinutes = ((totalMinutes % 1440) + 1440) % 1440;
  const nextHours = String(Math.floor(normalizedMinutes / 60)).padStart(2, '0');
  const nextMinutes = String(normalizedMinutes % 60).padStart(2, '0');
  const nextSeconds = String(seconds || 0).padStart(2, '0');

  return `${nextHours}:${nextMinutes}:${nextSeconds}`;
}

function buildAttendanceWindows(startTime, endTime) {
  return {
    clock_in_start: startTime ? addMinutesToTime(startTime, -30) : null,
    clock_in_end: startTime ? addMinutesToTime(startTime, 120) : null,
    clock_out_start: endTime ? addMinutesToTime(endTime, -60) : null,
    clock_out_end: endTime ? addMinutesToTime(endTime, 180) : null
  };
}

function parseWorkDays(workDaysString) {
  if (!workDaysString) return [];
  
  // If already an array, return it
  if (Array.isArray(workDaysString)) {
    return workDaysString;
  }
  
  // If it's an object (Buffer), convert to string first
  if (typeof workDaysString === 'object') {
    workDaysString = workDaysString.toString();
  }
  
  // If not a string at this point, return empty array
  if (typeof workDaysString !== 'string') {
    return [];
  }
  
  try {
    // Try parse as JSON first
    return JSON.parse(workDaysString);
  } catch (e) {
    // If failed, assume it's comma-separated string (old format)
    // Convert "monday,tuesday,wednesday" to ["monday","tuesday","wednesday"]
    return workDaysString.split(',').map(day => day.trim()).filter(day => day);
  }
}

function isDevelopmentMode() {
  return (process.env.NODE_ENV || 'development') === 'development';
}

async function isDevScheduleBypassEnabled() {
  // Kalau ENFORCE_SCHEDULE=true, presensi WAJIB mengikuti jadwal shift (bypass dimatikan),
  // walaupun server berjalan di mode development. Default: ikut mode development.
  if (String(process.env.ENFORCE_SCHEDULE || '').toLowerCase() === 'true') return false;
  return isDevelopmentMode();
}

function extractReferenceFaces(faceRows) {
  const referenceFaces = [];

  for (const row of faceRows) {
    let parsedEncoding = row.face_encoding ?? row.faces_data;
    if (!parsedEncoding) {
      continue;
    }

    if (typeof parsedEncoding === 'string') {
      try {
        parsedEncoding = JSON.parse(parsedEncoding);
      } catch (error) {
        throw new Error('INVALID_FACE_DATA');
      }
    }

    if (Array.isArray(parsedEncoding)) {
      referenceFaces.push(...parsedEncoding);
    } else {
      referenceFaces.push(parsedEncoding);
    }
  }

  if (!referenceFaces.length) {
    throw new Error('INVALID_FACE_DATA');
  }

  return referenceFaces;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateTokenId() {
  return crypto.randomUUID();
}

function parseJwtExpiryToDate(token) {
  const [, payloadPart] = token.split('.');
  const payloadJson = Buffer.from(payloadPart, 'base64url').toString('utf8');
  const payload = JSON.parse(payloadJson);
  return new Date(payload.exp * 1000);
}

async function persistRefreshToken(connection, {
  tokenId,
  employeeId,
  refreshToken
}) {
  const tokenHash = hashToken(refreshToken);
  const expiresAt = parseJwtExpiryToDate(refreshToken);

  await connection.execute(
    `INSERT INTO refresh_tokens
      (id, id_karyawan, token_hash, expires_at)
     VALUES (?, ?, ?, ?)`,
    [
      tokenId,
      employeeId,
      tokenHash,
      expiresAt
    ]
  );
}

async function revokeRefreshTokenById(connection, tokenId) {
  await connection.execute(
    `UPDATE refresh_tokens
     SET revoked_at = COALESCE(revoked_at, NOW())
     WHERE id = ?`,
    [tokenId]
  );
}

async function revokeAllEmployeeRefreshTokens(connection, employeeId) {
  await connection.execute(
    `UPDATE refresh_tokens
     SET revoked_at = COALESCE(revoked_at, NOW())
     WHERE id_karyawan = ? AND revoked_at IS NULL`,
    [employeeId]
  );
}

async function getStoredRefreshToken(connection, tokenId, employeeId) {
  const [rows] = await connection.execute(
    `SELECT id, id_karyawan, token_hash, expires_at, revoked_at
     FROM refresh_tokens
     WHERE id = ?
       AND id_karyawan = ?
     LIMIT 1`,
    [tokenId, employeeId]
  );

  return rows;
}

async function saveEmailVerificationOtp(connection, {
  employeeId,
  email,
  otpCode,
  expiresAt
}) {
  await connection.execute(
    `UPDATE karyawan
     SET email = ?,
         email_verified_at = NULL,
         email_verification_token = ?,
         email_verification_expires_at = ?,
         email_verification_sent_at = NOW()
     WHERE id = ? AND deleted_at IS NULL`,
    [email, otpCode, expiresAt, employeeId]
  );
}

async function getActiveEmailVerificationOtp(connection, { email, otpCode, nik = null }) {
  const params = [email, otpCode];
  let extraFilter = '';

  if (nik) {
    extraFilter = ' AND nik = ?';
    params.push(nik);
  }

  const [rows] = await connection.execute(
    `SELECT id, email_verification_expires_at AS expires_at
     FROM karyawan
     WHERE email = ?
       AND email_verification_token = ?
       AND deleted_at IS NULL${extraFilter}
     LIMIT 1`,
    params
  );

  return rows;
}

async function clearEmailVerificationOtp(connection, employeeId) {
  await connection.execute(
    `UPDATE karyawan
     SET email_verification_token = NULL,
         email_verification_expires_at = NULL,
         email_verification_sent_at = NULL
     WHERE id = ? AND deleted_at IS NULL`,
    [employeeId]
  );
}

async function getApprovedLeaveForDate(connection, employeeId, date) {
  const [rows] = await connection.execute(`
    SELECT *
    FROM absensi
    WHERE id_karyawan = ?
      AND status IN ('approved', 'disetujui')
      AND tanggal_mulai <= ?
      AND tanggal_selesai >= ?
    ORDER BY created_at DESC
    LIMIT 1
  `, [employeeId, date, date]);
  return rows[0] || null;
}

function parseJsonColumn(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return {};
  }
}

function getCurrentDateTimeWITA() {
  return `${getCurrentDateWITA()} ${getCurrentTimeWITA()}`;
}

function parseDateTimeString(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] || 0)
  );
}

function diffDateTimeMinutes(startValue, endValue) {
  const start = parseDateTimeString(startValue);
  const end = parseDateTimeString(endValue);
  if (!start || !end) return 0;
  return Math.max(0, Math.floor((end - start) / (1000 * 60)));
}

function normalizeBreakData(value) {
  const parsed = parseJsonColumn(value);
  const sessions = Array.isArray(parsed.sesi) ? parsed.sesi : [];
  const hasActiveSession = sessions.some(session => session && session.mulai && !session.selesai);
  const totalMinutes = Number.isFinite(Number(parsed.total_menit))
    ? Number(parsed.total_menit)
    : sessions.reduce((sum, session) => sum + Number(session?.durasi_menit || 0), 0);
  const countedMinutes = Number.isFinite(Number(parsed.dihitung_menit))
    ? Number(parsed.dihitung_menit)
    : null;
  const storedAllowanceMinutes = Number.isFinite(Number(parsed.durasi_istirahat_menit))
    ? Number(parsed.durasi_istirahat_menit)
    : null;

  return {
    status: parsed.status || (hasActiveSession ? 'berlangsung' : (sessions.length ? 'selesai' : 'belum_mulai')),
    total_menit: totalMinutes,
    dihitung_menit: countedMinutes,
    durasi_istirahat_menit: storedAllowanceMinutes,
    sesi: sessions
  };
}

function normalizeBreakAllowanceMinutes(value) {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : DEFAULT_BREAK_ALLOWANCE_MINUTES;
}

async function getBreakAllowanceMinutes(connection) {
  try {
    const [rows] = await connection.execute(
      `SELECT durasi_istirahat_menit FROM pengaturan LIMIT 1`
    );
    const minutes = rows.length > 0 ? Number(rows[0].durasi_istirahat_menit) : null;
    return Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : DEFAULT_BREAK_ALLOWANCE_MINUTES;
  } catch (err) {
    console.error('Gagal membaca durasi istirahat dari pengaturan:', err.message);
    return DEFAULT_BREAK_ALLOWANCE_MINUTES;
  }
}

// Istirahat disimpan di dalam kolom JSON data_masuk (tabel presensi tidak punya kolom data_istirahat)
function extractBreakFromDataMasuk(dataMasukValue) {
  const parsed = parseJsonColumn(dataMasukValue);
  return normalizeBreakData(parsed.istirahat || null);
}

function mergeBreakIntoDataMasuk(dataMasukValue, breakData) {
  const parsed = parseJsonColumn(dataMasukValue);
  parsed.istirahat = breakData;
  return JSON.stringify(parsed);
}

function getActiveBreakSessionIndex(breakData) {
  return breakData.sesi.findIndex(session => session && session.mulai && !session.selesai);
}

function recalculateBreakTotalMinutes(breakData) {
  return breakData.sesi.reduce((sum, session) => sum + Number(session?.durasi_menit || 0), 0);
}

function calculateCountedBreakMinutes(breakData, breakAllowanceMinutes = DEFAULT_BREAK_ALLOWANCE_MINUTES, includeActive = false) {
  const sessions = Array.isArray(breakData?.sesi) ? breakData.sesi : [];
  if (sessions.length === 0) return 0;

  const activeIndex = includeActive ? getActiveBreakSessionIndex(breakData) : -1;
  const activeSession = activeIndex >= 0 ? breakData.sesi[activeIndex] : null;
  const activeDurationMinutes = activeSession
    ? diffDateTimeMinutes(activeSession.mulai, getCurrentDateTimeWITA())
    : 0;
  // Istirahat yang dipotong = lama istirahat AKTUAL (bukan dipaksa minimal jatah).
  return Number(breakData.total_menit || 0) + activeDurationMinutes;
}

function getStoredOrCountedBreakMinutes(breakData, breakAllowanceMinutes = DEFAULT_BREAK_ALLOWANCE_MINUTES) {
  if (Number.isFinite(Number(breakData?.dihitung_menit))) {
    return Number(breakData.dihitung_menit);
  }
  return calculateCountedBreakMinutes(breakData, breakAllowanceMinutes, false);
}

function closeActiveBreakSession(breakData, finishedAt, extraFields = {}) {
  const activeIndex = getActiveBreakSessionIndex(breakData);
  if (activeIndex < 0) {
    return { closed: false, breakData };
  }

  const activeSession = breakData.sesi[activeIndex];
  const durationMinutes = diffDateTimeMinutes(activeSession.mulai, finishedAt);
  breakData.sesi[activeIndex] = {
    ...activeSession,
    selesai: finishedAt,
    durasi_menit: durationMinutes,
    ...extraFields
  };
  breakData.status = 'selesai';
  breakData.total_menit = recalculateBreakTotalMinutes(breakData);
  return { closed: true, breakData, closedSession: breakData.sesi[activeIndex] };
}

function buildBreakResponse(breakData, hasCheckedIn, hasCheckedOut, breakAllowanceMinutes = DEFAULT_BREAK_ALLOWANCE_MINUTES) {
  const activeIndex = getActiveBreakSessionIndex(breakData);
  const activeSession = activeIndex >= 0 ? breakData.sesi[activeIndex] : null;
  const canStartBreak = Boolean(hasCheckedIn && !hasCheckedOut && !activeSession);
  const canEndBreak = Boolean(hasCheckedIn && !hasCheckedOut && activeSession);
  const activeDurationMinutes = activeSession
    ? diffDateTimeMinutes(activeSession.mulai, getCurrentDateTimeWITA())
    : 0;
  const totalMinutes = Number(breakData.total_menit || 0);
  const runningTotalMinutes = totalMinutes + activeDurationMinutes;
  const allowanceMinutes = normalizeBreakAllowanceMinutes(breakAllowanceMinutes);
  const countedMinutes = Number.isFinite(Number(breakData.dihitung_menit)) && !activeSession
    ? Number(breakData.dihitung_menit)
    : calculateCountedBreakMinutes(breakData, allowanceMinutes, true);

  return {
    status: breakData.status,
    total_menit: totalMinutes,
    durasi_aktif_menit: activeDurationMinutes,
    total_berjalan_menit: runningTotalMinutes,
    durasi_istirahat_menit: allowanceMinutes,
    dihitung_menit: countedMinutes,
    sisa_istirahat_menit: Math.max(0, allowanceMinutes - runningTotalMinutes),
    kelebihan_istirahat_menit: Math.max(0, runningTotalMinutes - allowanceMinutes),
    sesi: breakData.sesi,
    sedang_istirahat: Boolean(activeSession),
    mulai_aktif: activeSession?.mulai || null,
    canStartBreak,
    canEndBreak
  };
}

function buildPresensiEventData({ metode = 'face_pin', photoPath, latitude, longitude, distance, similarity, deviceInfo }) {
  return JSON.stringify({
    metode,
    foto: photoPath ? photoPath.replace(/\\/g, '/') : null,
    latitude: latitude != null ? Number(latitude) : null,
    longitude: longitude != null ? Number(longitude) : null,
    jarak_meter: distance != null ? Number(distance) : null,
    face_similarity: similarity != null ? Number(similarity) : null,
    device_info: deviceInfo || null
  });
}

function mapShiftRow(shift) {
  if (!shift) return null;
  return {
    id: shift.id,
    name: shift.nama_shift,
    code: shift.kode_shift,
    start_time: shift.jam_masuk,
    end_time: shift.jam_keluar
  };
}

function mapShiftRowV2(shift) {
  if (!shift) return null;
  return {
    id: shift.id,
    name: shift.name,
    code: shift.code,
    start_time: shift.start_time,
    end_time: shift.end_time
  };
}

function toLegacyEmployeePayloadV2(row) {
  return {
    id: row.id,
    nik: row.nik,
    nama: row.nama,
    email: row.email,
    no_hp: row.phone,
    phone: row.phone,
    jenis_kelamin: row.jenis_kelamin || null,
    tanggal_lahir: row.tanggal_lahir || null,
    address: row.address || null,
    profile_picture: row.profile_picture || null,
    jabatan: row.jabatan_id ? {
      id: row.jabatan_id,
      nama_jabatan: row.nama_jabatan,
      deskripsi: row.jabatan_deskripsi
    } : null,
    is_activated: row.status === 'active',
    email_verified: !!row.email_verified_at,
    foto_referensi: null,
    face_enrollment_completed: Number(row.face_enrollment_completed || 0) > 0,
    id_jadwal_kerja: row.id_jadwal_kerja,
    shift_id: row.shift_id,
    created_at: row.created_at
  };
}

async function getEmployeeScheduleAndShiftV2(connection, workScheduleId, employeeShiftId) {
  let workSchedule = null;
  let shift = null;

  if (workScheduleId) {
    const [scheduleRows] = await connection.execute(`
      SELECT
        ws.id,
        ws.nama,
        ws.hari_kerja,
        ws.is_active,
        ws.shift_id
      FROM jadwal_kerja ws
      WHERE ws.id = ?
      LIMIT 1
    `, [workScheduleId]);

    if (scheduleRows.length) {
      const schedule = scheduleRows[0];
      workSchedule = {
        id: schedule.id,
        name: schedule.nama,
        start_time: null,
        end_time: null,
        clock_in_start: null,
        clock_in_end: null,
        clock_out_start: null,
        clock_out_end: null,
        work_days: parseWorkDays(schedule.hari_kerja),
        is_active: schedule.is_active === 1 || schedule.is_active === true
      };

      const activeShiftId = employeeShiftId || schedule.shift_id || null;
      if (activeShiftId) {
        const [shiftRows] = await connection.execute(`
          SELECT
            id,
            kode_shift AS code,
            nama_shift AS name,
            jam_masuk AS start_time,
            jam_keluar AS end_time
          FROM shift
          WHERE id = ?
          LIMIT 1
        `, [activeShiftId]);

        if (shiftRows.length) {
          shift = mapShiftRowV2(shiftRows[0]);
          workSchedule.start_time = shift.start_time;
          workSchedule.end_time = shift.end_time;
          Object.assign(workSchedule, buildAttendanceWindows(shift.start_time, shift.end_time));
        }
      }
    }
  }

  return { workSchedule, shift };
}

// ============================================
// FILE UPLOAD CONFIGURATION (MULTER)
// ============================================

/**
 * Konfigurasi upload untuk foto referensi wajah karyawan
 * - Lokasi: public/uploads/karyawan/
 * - Format nama: ref-[timestamp]-[random].ext
 * - Max size: 10MB
 */
const storage = multer.diskStorage(createUploadStorage({
  localDirectory: 'public/uploads/karyawan',
  filenamePrefix: 'ref'
}));

const upload = multer({
  storage: storage,
  // Filter: hanya terima file gambar
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('File must be an image'), false);
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // Maksimal 10MB
  }
});

/**
 * Konfigurasi upload untuk foto profil karyawan
 * - Lokasi: public/uploads/profiles/
 * - Format nama: profile-[timestamp]-[random].ext
 * - Max size: 5MB
 */
const profileStorage = multer.diskStorage(createUploadStorage({
  localDirectory: 'public/uploads/profiles',
  filenamePrefix: 'profile'
}));

const uploadProfile = multer({
  storage: profileStorage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('File must be an image'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // Maksimal 5MB untuk foto profil
  }
});

/**
 * Konfigurasi upload lampiran Absensi
 * - Lokasi: public/uploads/leave/
 * - Format: leave-[timestamp]-[random].ext
 * - Tipe: JPG, PNG, PDF
 * - Max size: 5MB
 */
const leaveAttachmentStorage = multer.diskStorage(createUploadStorage({
  localDirectory: 'public/uploads/leave',
  filenamePrefix: 'leave'
}));

const leaveUpload = multer({
  storage: leaveAttachmentStorage,
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'application/pdf'];
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Lampiran hanya boleh JPG, PNG, atau PDF'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});

// ============================================
// AUTHENTICATION APIs (Autentikasi)
// ============================================

/**
 * @swagger
 * /api/auth/check-nik:
 *   post:
 *     tags: [Authentication]
 *     summary: Check apakah NIK terdaftar dan status aktivasi
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - nik
 *             properties:
 *               nik:
 *                 type: string
 *                 description: NIK karyawan
 *                 example: "EMP001"
 *     responses:
 *       200:
 *         description: NIK ditemukan
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     exists:
 *                       type: boolean
 *                     is_activated:
 *                       type: boolean
 *                     employee:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: integer
 *                         nik:
 *                           type: string
 *                         nama:
 *                           type: string
 */
router.post('/auth/check-nik', async (req, res) => {
  const connection = await getConnection();
  
  try {
    const { nik } = req.body;

    if (!nik) {
      return res.status(400).json({
        success: false,
        message: 'NIK is required',
        code: 'MISSING_NIK'
      });
    }

    // V2 schema lookup (karyawan + karyawan_face_reference)
    const [rows] = await connection.execute(`
      SELECT 
        e.id, e.nik, e.nama AS nama, e.status,
        COUNT(fr.id) as has_face_reference_table
      FROM karyawan e
      LEFT JOIN karyawan_face_reference fr ON e.id = fr.id_karyawan AND fr.is_active = TRUE
      WHERE e.nik = ? AND e.deleted_at IS NULL
      GROUP BY e.id
    `, [nik]);

    if (rows.length === 0) {
      return res.json({
        success: true,
        message: 'NIK not found',
        data: {
          exists: false,
          is_activated: false,
          has_face_reference: false,
          employee: null
        }
      });
    }

    const karyawan = rows[0];
    const hasFaceReference = Number(karyawan.has_face_reference_table) > 0;

    res.json({
      success: true,
      message: 'NIK found',
      data: {
        exists: true,
        is_activated: karyawan.status === 'active',
        has_face_reference: hasFaceReference,
        employee: {
          id: karyawan.id,
          nik: karyawan.nik,
          nama: karyawan.nama
        }
      }
    });

  } catch (error) {
    console.error('Check NIK error:', error);
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
 * /api/auth/login:
 *   post:
 *     tags: [Authentication]
 *     summary: Login karyawan dengan NIK dan PIN
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - nik
 *               - pin
 *             properties:
 *               nik:
 *                 type: string
 *                 description: NIK karyawan
 *                 example: "1234567890123456"
 *               pin:
 *                 type: string
 *                 description: PIN 6 digit
 *                 example: "123456"
 *     responses:
 *       200:
 *         description: Login berhasil
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Login successful"
 *                 data:
 *                   type: object
 *                   properties:
 *                     accessToken:
 *                       type: string
 *                     refreshToken:
 *                       type: string
 *                     user:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: integer
 *                         nik:
 *                           type: string
 *                         nama:
 *                           type: string
 *                         is_activated:
 *                           type: boolean
 *       400:
 *         description: Invalid credentials atau belum aktivasi
 *       401:
 *         description: PIN salah atau akun terkunci
 */
router.post('/auth/login', async (req, res) => {
  const connection = await getConnection();
  
  try {
    const { nik, pin, email } = req.body;

    if (!nik || !pin) {
      return res.status(400).json({
        success: false,
        message: 'NIK and PIN are required',
        code: 'MISSING_CREDENTIALS'
      });
    }

    // Get employee + security data from V2 schema
    const [rows] = await connection.execute(
      `SELECT
        e.id, e.nik, e.status, e.id_jadwal_kerja, e.shift_id,
        e.pin_hash, e.email_verified_at, e.email
       FROM karyawan e
       WHERE e.nik = ? AND e.deleted_at IS NULL
       LIMIT 1`,
      [nik]
    );

    if (rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'NIK not found',
        code: 'NIK_NOT_FOUND'
      });
    }

    const karyawan = rows[0];
    const isActivated = karyawan.status === 'active';

    if (!isActivated) {
      if (karyawan.email && karyawan.pin_hash && !karyawan.email_verified_at) {
        return res.status(403).json({
          success: false,
          message: 'Email verification is required before login',
          code: 'EMAIL_NOT_VERIFIED'
        });
      }

      return res.status(403).json({
        success: false,
        message: 'Account activation is incomplete. Please complete activation flow.',
        code: 'ACTIVATION_INCOMPLETE'
      });
    }

    // Verify PIN
    if (!karyawan.pin_hash) {
      return res.status(401).json({
        success: false,
        message: 'PIN not set',
        code: 'PIN_NOT_SET'
      });
    }

    const isPinValid = await bcrypt.compare(pin, karyawan.pin_hash);
    
    if (!isPinValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid PIN',
        code: 'INVALID_PIN'
      });
    }

    // Get complete employee data (V2)
    const [employeeData] = await connection.execute(`
      SELECT 
        e.id,
        e.nik,
        e.nama AS nama,
        e.email,
        e.phone,
        e.id_jadwal_kerja,
        e.shift_id,
        e.created_at,
        e.status,
        e.profile_picture AS profile_picture,
        e.email_verified_at,
        p.id as jabatan_id,
        p.nama_jabatan as nama_jabatan,
        p.deskripsi as jabatan_deskripsi,
        COUNT(fr.id) as face_enrollment_completed
      FROM karyawan e
      LEFT JOIN jabatan p ON e.id_jabatan = p.id
      LEFT JOIN karyawan_face_reference fr ON e.id = fr.id_karyawan AND fr.is_active = TRUE
      WHERE e.id = ?
      GROUP BY e.id
    `, [karyawan.id]);

    const employee = employeeData[0];

    const { workSchedule, shift } = await getEmployeeScheduleAndShiftV2(
      connection,
      employee.id_jadwal_kerja,
      employee.shift_id
    );

    // Generate tokens
    const refreshTokenId = generateTokenId();
    const accessToken = generateAccessToken({ 
      id: employee.id, 
      nik: employee.nik 
    });
    const refreshToken = generateRefreshToken({ 
      id: employee.id, 
      nik: employee.nik,
      token_id: refreshTokenId
    });

    await persistRefreshToken(connection, {
      tokenId: refreshTokenId,
      employeeId: employee.id,
      refreshToken
    });

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        employee: toLegacyEmployeePayloadV2(employee),
        tokens: {
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: 3600
        },
        work_schedule: workSchedule,
        shift: shift
      }
    });

  } catch (error) {
    console.error('Login error:', error);
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
 * /api/auth/activate:
 *   post:
 *     tags: [Authentication]
 *     summary: Activate account dengan NIK, PIN, dan foto wajah (all-in-one)
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - nik
 *               - pin
 *               - face_photo_1
 *               - face_photo_2
 *               - face_photo_3
 *             properties:
 *               nik:
 *                 type: string
 *                 description: NIK karyawan
 *               pin:
 *                 type: string
 *                 description: PIN 6 digit
 *               face_photo_1:
 *                 type: string
 *                 format: binary
 *                 description: Foto wajah referensi 1 (depan)
 *               face_photo_2:
 *                 type: string
 *                 format: binary
 *                 description: Foto wajah referensi 2 (miring kiri)
 *               face_photo_3:
 *                 type: string
 *                 format: binary
 *                 description: Foto wajah referensi 3 (miring kanan)
 *     responses:
 *       200:
 *         description: Aktivasi berhasil
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     employee:
 *                       type: object
 *                     tokens:
 *                       type: object
 *                     face_enrollment:
 *                       type: object
 */
router.post('/auth/activate', upload.any(), async (req, res) => {
  const connection = await getConnection();

  try {
    console.log('Activate request body:', req.body);
    // Multi-pose burst enrollment: accept any number of face photos (field name(s) flexible).
    const uploadedFiles = Array.isArray(req.files) ? req.files.slice() : [];
    const cleanupUploadedFiles = async () => {
      await Promise.all(uploadedFiles.map((file) => discardUploadedFile(file)));
    };
    console.log('Activate request files:', uploadedFiles.map((f) => f.filename));
    
    const { nik, pin } = req.body;
    const email = (req.body.email || '').trim();

    if (!nik || !pin) {
      console.log('Missing credentials - NIK:', nik, 'PIN:', pin ? '***' : 'empty');
      await cleanupUploadedFiles();
      return res.status(400).json({
        success: false,
        message: 'NIK and PIN are required',
        code: 'MISSING_CREDENTIALS'
      });
    }

    if (uploadedFiles.length < 1 || uploadedFiles.length > 30) {
      await cleanupUploadedFiles();
      return res.status(400).json({
        success: false,
        message: 'Between 1 and 30 face photos are required',
        code: 'INVALID_FACE_PHOTO_COUNT'
      });
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      await cleanupUploadedFiles();
      return res.status(400).json({
        success: false,
        message: 'Email format is invalid',
        code: 'INVALID_EMAIL'
      });
    }

    // Validate PIN format (6 digits)
    if (pin.length !== 6 || !/^\d{6}$/.test(pin)) {
      await cleanupUploadedFiles();
      return res.status(400).json({
        success: false,
        message: 'PIN must be exactly 6 digits',
        code: 'INVALID_PIN_FORMAT'
      });
    }

    // Get employee data
    const [rows] = await connection.execute(`
      SELECT e.id, e.nik, e.nama AS nama, e.email, e.status, e.email_verified_at
      FROM karyawan e
      WHERE e.nik = ? AND e.deleted_at IS NULL
      LIMIT 1
    `, [nik]);

    if (rows.length === 0) {
      await cleanupUploadedFiles();
      return res.status(400).json({
        success: false,
        message: 'NIK not found',
        code: 'NIK_NOT_FOUND'
      });
    }

    const karyawan = rows[0];

    // Check if already activated
    if (karyawan.status === 'active') {
      await cleanupUploadedFiles();
      return res.status(400).json({
        success: false,
        message: 'Account is already activated',
        code: 'ALREADY_ACTIVATED'
      });
    }

    // Multi-pose burst enrollment: keep frames with exactly one CLEAR face; skip blurry/empty ones.
    const detectedReferenceFaces = [];
    const MIN_ENROLL_SCORE = Number(process.env.FACE_ENROLL_MIN_SCORE) || 0.7;
    const MIN_ENROLL_FACE_PX = Number(process.env.FACE_ENROLL_MIN_SIZE_PX) || 100;
    const MIN_GOOD_REFERENCES = Number(process.env.FACE_ENROLL_MIN_GOOD) || 3;
    for (let index = 0; index < uploadedFiles.length; index++) {
      const facePhoto = uploadedFiles[index];
      let faces = [];
      try { faces = await detectFaces(facePhoto.path); } catch (e) { faces = []; }

      // Skip HANYA kalau tidak ada wajah. Kalau kedeteksi >1 (wajah di latar / pantulan / false-positive),
      // ambil wajah TERBESAR (paling dekat = orang yang mendaftar) — jangan tolak fotonya.
      if (faces.length === 0) { await discardUploadedFile(facePhoto); continue; }
      const refFace = faces.reduce((a, b) =>
        ((a.box.width * a.box.height) >= (b.box.width * b.box.height)) ? a : b
      );
      if (refFace.confidence < MIN_ENROLL_SCORE
          || refFace.box.width < MIN_ENROLL_FACE_PX
          || refFace.box.height < MIN_ENROLL_FACE_PX) {
        await discardUploadedFile(facePhoto);
        continue;
      }

      detectedReferenceFaces.push({
        face: refFace,
        filename: facePhoto.filename,
        path: facePhoto.path,
        file: facePhoto
      });
    }
    console.log(`Enrollment quality filter: kept ${detectedReferenceFaces.length}/${uploadedFiles.length} frames`);

    if (detectedReferenceFaces.length < MIN_GOOD_REFERENCES) {
      await cleanupUploadedFiles();
      return res.status(400).json({
        success: false,
        message: `Foto wajah jelas kurang (${detectedReferenceFaces.length}). Ulangi: dekatkan wajah, cahaya cukup, lalu putar wajah perlahan.`,
        code: 'NOT_ENOUGH_CLEAR_FACES'
      });
    }

    for (const referenceFace of detectedReferenceFaces) {
      referenceFace.storedPath = await persistUploadedFile(referenceFace.file, { folder: 'uploads/karyawan' });
    }

    // Hash PIN
    const hashedPin = await bcrypt.hash(pin, 10);

    // Start transaction
    await connection.beginTransaction();

    try {
      // 1. Update employee + security data and activate (or keep draft until email verified)
      console.log('Updating karyawan:', karyawan.id);
      let verificationToken = null;
      let verificationExpiresAt = null;
      if (email) {
        verificationToken = generateVerificationOtp();
        verificationExpiresAt = getVerificationExpiry(24);
      }

      await connection.execute(
        `UPDATE karyawan
         SET email = COALESCE(?, email),
             profile_picture = ?,
             status = ?,
             pin_hash = ?,
             face_enrollment_completed = TRUE,
             email_verification_token = ?,
             email_verification_expires_at = ?,
             email_verification_sent_at = ?,
             email_verified_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
        [
          email || null,
          detectedReferenceFaces[0].storedPath,
          email ? 'draft' : 'active',
          hashedPin,
          verificationToken,
          verificationExpiresAt,
          email ? new Date() : null,
          email ? null : new Date(),
          karyawan.id
        ]
      );

      // 2. Deactivate existing face references
      console.log('Deactivating old face references');
      await connection.execute(
        'UPDATE karyawan_face_reference SET is_active = FALSE WHERE id_karyawan = ?',
        [karyawan.id]
      );

      // 3. Save new face references (3 photos)
      console.log('Saving new face references');
      for (const referenceFace of detectedReferenceFaces) {
        await connection.execute(`
          INSERT INTO karyawan_face_reference 
          (id_karyawan, face_encoding, photo_path, is_active, enrollment_method) 
          VALUES (?, ?, ?, TRUE, 'manual')
        `, [
          karyawan.id,
          JSON.stringify(referenceFace.face),
          referenceFace.storedPath
        ]);
      }
      console.log('Face references saved successfully');

      await connection.commit();
      console.log('Transaction committed');

      if (email && verificationToken) {
        await sendVerificationEmail({
          email,
          name: karyawan.nama,
          token: verificationToken
        });
      }

      // Generate tokens
      const refreshTokenId = generateTokenId();
      const accessToken = generateAccessToken({ 
        id: karyawan.id, 
        nik: karyawan.nik 
      });
      const refreshToken = generateRefreshToken({ 
        id: karyawan.id, 
        nik: karyawan.nik,
        token_id: refreshTokenId
      });

      await persistRefreshToken(connection, {
        tokenId: refreshTokenId,
        employeeId: karyawan.id,
        refreshToken
      });

      res.json({
        success: true,
        message: 'Account activated successfully',
        data: {
          employee: {
            id: karyawan.id,
            nik: karyawan.nik,
            nama: karyawan.nama,
            email: email || karyawan.email || null,
            is_activated: !email
          },
          tokens: {
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: 3600
          },
          face_enrollment: {
            faces_detected: detectedReferenceFaces.length,
            enrollment_completed: true,
            photo_saved: detectedReferenceFaces[0].filename
          },
          requires_email_verification: !!email
        }
      });

    } catch (error) {
      await connection.rollback();
      throw error;
    }

  } catch (error) {
    console.error('Activation error:', error);
    console.error('Error stack:', error.stack);
    
    // Delete uploaded files on error (multi-pose burst: req.files is an array)
    const cleanupFiles = Array.isArray(req.files) ? req.files : [];
    await Promise.all(cleanupFiles.map((file) => discardUploadedFile(file)));
    
    res.status(500).json({
      success: false,
      message: 'Failed to activate account',
      code: 'ACTIVATION_ERROR',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    await connection.end();
  }
});

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     tags: [Authentication]
 *     summary: Logout karyawan
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Logout berhasil
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Logout successful"
 */
router.post('/auth/logout', authenticateToken, async (req, res) => {
  const connection = await getConnection();

  try {
    await revokeAllEmployeeRefreshTokens(connection, req.user.id);
    
    res.json({
      success: true,
      message: 'Logout successful'
    });
  } catch (error) {
    console.error('Logout error:', error);
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
 * /api/auth/verify-email:
 *   get:
 *     tags: [Authentication]
 *     summary: Verifikasi email akun karyawan
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *         description: Token verifikasi email
 *       - in: query
 *         name: email
 *         required: true
 *         schema:
 *           type: string
 *         description: Email karyawan yang diverifikasi
 *     responses:
 *       200:
 *         description: Email berhasil diverifikasi
 *       404:
 *         description: Data verifikasi tidak ditemukan
 *       410:
 *         description: Token verifikasi sudah kadaluwarsa
 */
router.get('/auth/verify-email', async (req, res) => {
  const connection = await getConnection();
  const wantsHtml = (req.headers.accept || '').includes('text/html');

  const sendVerificationResult = (statusCode, payload) => {
    if (!wantsHtml) {
      return res.status(statusCode).json(payload);
    }

    const isSuccess = statusCode >= 200 && statusCode < 300;
    const title = isSuccess ? 'Verifikasi Berhasil' : 'Verifikasi Gagal';
    const color = isSuccess ? '#15803d' : '#b91c1c';
    const html = `
      <!doctype html>
      <html lang="id">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>${title}</title>
          <style>
            body { font-family: Arial, sans-serif; background:#f5f5f4; margin:0; padding:24px; }
            .card { max-width:520px; margin:40px auto; background:#fff; border-radius:14px; padding:24px; box-shadow:0 10px 24px rgba(0,0,0,0.08); }
            h1 { margin:0 0 12px; font-size:24px; color:${color}; }
            p { margin:0; color:#1f2937; line-height:1.5; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>${title}</h1>
            <p>${payload.message}</p>
          </div>
        </body>
      </html>
    `;
    return res.status(statusCode).send(html);
  };

  try {
    const { token, email } = req.query;
    if (!token || !email) {
      return sendVerificationResult(400, {
        success: false,
        message: 'Token and email are required',
        code: 'MISSING_VERIFICATION_DATA'
      });
    }

    const rows = await getActiveEmailVerificationOtp(connection, {
      email,
      otpCode: token
    });

    if (!rows.length) {
      return sendVerificationResult(404, {
        success: false,
        message: 'Verification data not found',
        code: 'VERIFICATION_NOT_FOUND'
      });
    }

    const employee = rows[0];
    if (employee.expires_at && new Date(employee.expires_at) < new Date()) {
      return sendVerificationResult(410, {
        success: false,
        message: 'Verification token has expired',
        code: 'VERIFICATION_EXPIRED'
      });
    }

    await connection.execute(`
      UPDATE karyawan
      SET email_verified_at = NOW(),
          status = 'active',
          email_verification_token = NULL,
          email_verification_expires_at = NULL,
          email_verification_sent_at = NULL
      WHERE id = ? AND deleted_at IS NULL
    `, [employee.id]);

    sendVerificationResult(200, {
      success: true,
      message: 'Email verified successfully'
    });
  } catch (error) {
    console.error('Email verification error:', error);
    sendVerificationResult(500, {
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
 * /api/auth/request-email-otp:
 *   post:
 *     summary: Request OTP untuk verifikasi email
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - nik
 *               - email
 *             properties:
 *               nik:
 *                 type: string
 *                 example: "1111111111111111"
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "employee@example.com"
 *     responses:
 *       200:
 *         description: OTP berhasil dikirim
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "OTP verifikasi berhasil dikirim"
 *                 data:
 *                   type: object
 *                   properties:
 *                     delivery_mode:
 *                       type: string
 *                       example: "email"
 *       400:
 *         description: Data tidak valid atau akun sudah aktif
 *       404:
 *         description: NIK tidak ditemukan
 */
router.post('/auth/request-email-otp', async (req, res) => {
  const connection = await getConnection();

  try {
    const { nik, email } = req.body;
    if (!nik || !email) {
      return res.status(400).json({
        success: false,
        message: 'NIK dan email wajib diisi',
        code: 'MISSING_VERIFICATION_DATA'
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Format email tidak valid',
        code: 'INVALID_EMAIL'
      });
    }

    const [rows] = await connection.execute(`
      SELECT id, nama AS nama, status
      FROM karyawan
      WHERE nik = ? AND deleted_at IS NULL
      LIMIT 1
    `, [nik]);

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: 'NIK tidak ditemukan',
        code: 'NIK_NOT_FOUND'
      });
    }

    if (rows[0].status === 'active') {
      return res.status(400).json({
        success: false,
        message: 'Akun sudah aktif. Silakan login.',
        code: 'ALREADY_ACTIVATED'
      });
    }

    const otp = generateVerificationOtp();
    const expiresAt = getVerificationExpiry(24);

    await saveEmailVerificationOtp(connection, {
      employeeId: rows[0].id,
      email,
      otpCode: otp,
      expiresAt
    });

    await connection.execute(`
      UPDATE karyawan
      SET status = 'draft'
      WHERE id = ? AND deleted_at IS NULL
    `, [rows[0].id]);

    const delivery = await sendVerificationEmail({
      email,
      name: rows[0].nama,
      token: otp
    });

    return res.json({
      success: true,
      message: 'OTP verifikasi berhasil dikirim',
      data: {
        delivery_mode: delivery.mode
      }
    });
  } catch (error) {
    console.error('Request email OTP error:', error);
    return res.status(500).json({
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
 * /api/auth/verify-email-otp:
 *   post:
 *     summary: Verifikasi OTP email
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - nik
 *               - email
 *               - otp
 *             properties:
 *               nik:
 *                 type: string
 *                 example: "1111111111111111"
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "employee@example.com"
 *               otp:
 *                 type: string
 *                 example: "123456"
 *     responses:
 *       200:
 *         description: Email berhasil diverifikasi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Email berhasil diverifikasi"
 *       400:
 *         description: OTP tidak valid atau sudah kadaluwarsa
 *       404:
 *         description: NIK tidak ditemukan
 */
router.post('/auth/verify-email-otp', async (req, res) => {
  const connection = await getConnection();

  try {
    const { nik, email, otp } = req.body;
    if (!nik || !email || !otp) {
      return res.status(400).json({
        success: false,
        message: 'NIK, email, dan OTP wajib diisi',
        code: 'MISSING_VERIFICATION_DATA'
      });
    }

    const rows = await getActiveEmailVerificationOtp(connection, {
      email,
      otpCode: otp,
      nik
    });

    if (!rows.length) {
      return res.status(400).json({
        success: false,
        message: 'OTP tidak valid',
        code: 'INVALID_OTP'
      });
    }

    const employee = rows[0];
    if (employee.expires_at && new Date(employee.expires_at) < new Date()) {
      return res.status(410).json({
        success: false,
        message: 'OTP sudah kadaluarsa',
        code: 'OTP_EXPIRED'
      });
    }

    await connection.execute(`
      UPDATE karyawan
      SET email_verified_at = NOW(),
          status = 'draft',
          email_verification_token = NULL,
          email_verification_expires_at = NULL,
          email_verification_sent_at = NULL
      WHERE id = ? AND deleted_at IS NULL
    `, [employee.id]);

    return res.json({
      success: true,
      message: 'Verifikasi email berhasil'
    });
  } catch (error) {
    console.error('Verify email OTP error:', error);
    return res.status(500).json({
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
 * /api/auth/request-email-verification:
 *   post:
 *     tags: [Authentication]
 *     summary: Kirim ulang email verifikasi untuk user login
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Permintaan verifikasi email berhasil diproses
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Verification email requested successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     delivery_mode:
 *                       type: string
 *                       example: smtp
 *                     verification_url:
 *                       type: string
 *       400:
 *         description: Email belum tersedia pada akun
 */
router.post('/auth/request-email-verification', authenticateToken, async (req, res) => {
  const connection = await getConnection();

  try {
    const [rows] = await connection.execute(`
      SELECT e.id, e.nama AS nama, e.email
      FROM karyawan e
      WHERE e.id = ? AND e.deleted_at IS NULL
      LIMIT 1
    `, [req.user.id]);

    if (!rows.length || !rows[0].email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required before requesting verification',
        code: 'EMAIL_REQUIRED'
      });
    }

    const token = generateVerificationOtp();
    const expiresAt = getVerificationExpiry(24);

    await saveEmailVerificationOtp(connection, {
      employeeId: req.user.id,
      email: rows[0].email,
      otpCode: token,
      expiresAt
    });

    const delivery = await sendVerificationEmail({
      email: rows[0].email,
      name: rows[0].nama,
      token
    });

    res.json({
      success: true,
      message: 'Verification email requested successfully',
      data: {
        delivery_mode: delivery.mode,
        verification_url: delivery.verificationUrl
      }
    });
  } catch (error) {
    console.error('Request email verification error:', error);
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
 * /api/auth/profile/{id}:
 *   get:
 *     tags: [Authentication]
 *     summary: Get data profil karyawan dengan jadwal kerja
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID karyawan
 *     responses:
 *       200:
 *         description: Data profil berhasil diambil
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: integer
 *                     nik:
 *                       type: string
 *                     nama:
 *                       type: string
 *                     jabatan:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: integer
 *                         nama_jabatan:
 *                           type: string
 *                     workSchedule:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: integer
 *                         name:
 *                           type: string
 *                         start_time:
 *                           type: string
 *                         end_time:
 *                           type: string
 *                         work_days:
 *                           type: array
 *                           items:
 *                             type: string
 */
router.get('/auth/profile/:id', authenticateToken, async (req, res) => {
  const connection = await getConnection();
  
  try {
    const { id } = req.params;

    // Verify user can only access their own profile
    if (parseInt(id) !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied',
        code: 'ACCESS_DENIED'
      });
    }

    const [rows] = await connection.execute(`
      SELECT
        e.id,
        e.nik,
        e.nama AS nama,
        e.email,
        e.phone,
        e.jenis_kelamin,
        DATE_FORMAT(e.tanggal_lahir, '%Y-%m-%d') AS tanggal_lahir,
        e.address,
        e.profile_picture AS profile_picture,
        e.id_jadwal_kerja,
        e.shift_id,
        e.created_at,
        e.status,
        p.id AS jabatan_id,
        p.nama_jabatan AS nama_jabatan,
        p.deskripsi AS jabatan_deskripsi,
        e.email_verified_at,
        COUNT(fr.id) AS face_enrollment_completed
      FROM karyawan e
      LEFT JOIN jabatan p ON e.id_jabatan = p.id
      LEFT JOIN karyawan_face_reference fr ON fr.id_karyawan = e.id AND fr.is_active = TRUE
      WHERE e.id = ? AND e.deleted_at IS NULL
      GROUP BY e.id
    `, [id]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found',
        code: 'EMPLOYEE_NOT_FOUND'
      });
    }

    const employee = rows[0];
    const { workSchedule, shift } = await getEmployeeScheduleAndShiftV2(
      connection,
      employee.id_jadwal_kerja,
      employee.shift_id
    );

    res.json({
      success: true,
      message: 'Profile retrieved successfully',
      data: {
        employee: toLegacyEmployeePayloadV2(employee),
        work_schedule: workSchedule,
        shift: shift
      }
    });

  } catch (error) {
    console.error('Profile error:', error);
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
 * /api/auth/profile/{id}:
 *   put:
 *     tags: [Authentication]
 *     summary: Update employee profile (self-service)
 *     description: Employee can update their own email, phone, gender, birth date, address, and profile picture
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *               phone:
 *                 type: string
 *               jenis_kelamin:
 *                 type: string
 *                 enum: [L, P]
 *                 description: "L = Laki-laki, P = Perempuan"
 *               tanggal_lahir:
 *                 type: string
 *                 format: date
 *               address:
 *                 type: string
 *                 description: Alamat karyawan
 *               profile_picture:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Profile updated successfully
 */
router.put('/auth/profile/:id', authenticateToken, uploadProfile.single('profile_picture'), async (req, res) => {
  const connection = await getConnection();
  
  try {
    const { id } = req.params;
    const { email, phone, jenis_kelamin, tanggal_lahir, address } = req.body;

    // Verify user can only update their own profile
    if (parseInt(id) !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied',
        code: 'ACCESS_DENIED'
      });
    }

    // Get current profile to check for old profile picture
    const [currentProfile] = await connection.execute(
      'SELECT profile_picture FROM karyawan WHERE id = ? AND deleted_at IS NULL',
      [id]
    );

    const updates = [];
    const params = [];

    if (email !== undefined) {
      updates.push('email = ?');
      params.push(email);
    }

    if (phone !== undefined) {
      updates.push('phone = ?');
      params.push(phone);
    }

    if (jenis_kelamin !== undefined) {
      updates.push('jenis_kelamin = ?');
      params.push(jenis_kelamin || null);
    }

    if (tanggal_lahir !== undefined) {
      updates.push('tanggal_lahir = ?');
      params.push(tanggal_lahir || null);
    }

    if (address !== undefined) {
      updates.push('address = ?');
      params.push(address || null);
    }

    if (req.file) {
      const profilePicturePath = await persistUploadedFile(req.file, { folder: 'uploads/profiles' });
      updates.push('profile_picture = ?');
      params.push(profilePicturePath);

      // Delete old profile picture if exists
      if (currentProfile.length > 0 && currentProfile[0].profile_picture) {
        deleteStoredFile(currentProfile[0].profile_picture)
          .catch((err) => console.log('Error deleting old profile picture:', err.message));
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update',
        code: 'NO_UPDATES'
      });
    }

    params.push(id);
    updates.push('updated_at = NOW()');

    await connection.execute(
      `UPDATE karyawan SET ${updates.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
      params
    );

    // Get updated profile
    const [rows] = await connection.execute(`
      SELECT 
        e.id,
        e.nik,
        e.nama AS nama,
        e.email,
        e.phone,
        e.jenis_kelamin,
        DATE_FORMAT(e.tanggal_lahir, '%Y-%m-%d') AS tanggal_lahir,
        e.address,
        e.profile_picture AS profile_picture,
        e.id_jadwal_kerja,
        e.shift_id,
        e.created_at,
        e.status,
        p.id AS jabatan_id,
        p.nama_jabatan AS nama_jabatan,
        p.deskripsi AS jabatan_deskripsi,
        e.email_verified_at,
        COUNT(fr.id) AS face_enrollment_completed
      FROM karyawan e
      LEFT JOIN jabatan p ON e.id_jabatan = p.id
      LEFT JOIN karyawan_face_reference fr ON fr.id_karyawan = e.id AND fr.is_active = TRUE
      WHERE e.id = ? AND e.deleted_at IS NULL
      GROUP BY e.id
    `, [id]);

    const employee = rows[0];
    
    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        employee: toLegacyEmployeePayloadV2(employee)
      }
    });

  } catch (error) {
    console.error('Update profile error:', error);
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
 * /api/auth/refresh:
 *   post:
 *     tags: [Authentication]
 *     summary: Refresh access token dengan rotasi refresh token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refresh_token]
 *             properties:
 *               refresh_token:
 *                 type: string
 *                 description: Refresh token aktif (snake_case, format utama)
 *               refreshToken:
 *                 type: string
 *                 description: Refresh token aktif (camelCase, kompatibilitas lama)
 *     responses:
 *       200:
 *         description: Token berhasil di-refresh dan refresh token lama direvoke
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     access_token:
 *                       type: string
 *                     refresh_token:
 *                       type: string
 *                     expires_in:
 *                       type: integer
 *                       example: 3600
 *       401:
 *         description: Refresh token tidak valid, kedaluwarsa, atau sudah direvoke
 */
router.post('/auth/refresh', async (req, res) => {
  const connection = await getConnection();

  try {
    const refreshToken = req.body.refresh_token || req.body.refreshToken;

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        message: 'Refresh token required',
        code: 'REFRESH_TOKEN_REQUIRED'
      });
    }

    const decoded = verifyRefreshToken(refreshToken);
    const currentTokenId = decoded.token_id;

    if (!currentTokenId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid refresh token',
        code: 'INVALID_REFRESH_TOKEN'
      });
    }

    const storedRows = await getStoredRefreshToken(connection, currentTokenId, decoded.id);

    if (!storedRows.length) {
      return res.status(401).json({
        success: false,
        message: 'Refresh token not recognized',
        code: 'REFRESH_TOKEN_NOT_FOUND'
      });
    }

    const storedToken = storedRows[0];
    const incomingTokenHash = hashToken(refreshToken);

    if (storedToken.token_hash !== incomingTokenHash || storedToken.revoked_at) {
      return res.status(401).json({
        success: false,
        message: 'Refresh token has been revoked',
        code: 'REFRESH_TOKEN_REVOKED'
      });
    }

    if (new Date(storedToken.expires_at).getTime() <= Date.now()) {
      await revokeRefreshTokenById(connection, storedToken.id);
      return res.status(401).json({
        success: false,
        message: 'Refresh token expired',
        code: 'REFRESH_TOKEN_EXPIRED'
      });
    }

    const newRefreshTokenId = generateTokenId();
    const newAccessToken = generateAccessToken({ 
      id: decoded.id, 
      nik: decoded.nik 
    });
    const newRefreshToken = generateRefreshToken({ 
      id: decoded.id, 
      nik: decoded.nik,
      token_id: newRefreshTokenId
    });

    await persistRefreshToken(connection, {
      tokenId: newRefreshTokenId,
      employeeId: decoded.id,
      refreshToken: newRefreshToken
    });
    await revokeRefreshTokenById(connection, currentTokenId);

    res.json({
      success: true,
      message: 'Token refreshed successfully',
      data: {
        access_token: newAccessToken,
        refresh_token: newRefreshToken,
        expires_in: 3600
      }
    });

  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(401).json({
      success: false,
      message: 'Invalid refresh token',
      code: 'INVALID_REFRESH_TOKEN'
    });
  } finally {
    await connection.end();
  }
});

// ============================================
// ACTIVATION APIs (Aktivasi Akun)
// Endpoint untuk proses aktivasi akun karyawan baru
// ============================================

/**
 * @swagger
 * /api/activation/upload-face:
 *   post:
 *     tags: [Activation]
 *     summary: Upload foto referensi untuk face recognition
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - reference
 *             properties:
 *               reference:
 *                 type: string
 *                 format: binary
 *                 description: Foto referensi wajah
 *     responses:
 *       200:
 *         description: Foto referensi berhasil diupload
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Reference photo uploaded successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     referenceId:
 *                       type: integer
 *                     facesDetected:
 *                       type: integer
 *                     faces:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: integer
 *                           box:
 *                             type: object
 *                             properties:
 *                               xMin:
 *                                 type: integer
 *                               yMin:
 *                                 type: integer
 *                               xMax:
 *                                 type: integer
 *                               yMax:
 *                                 type: integer
 *                               width:
 *                                 type: integer
 *                               height:
 *                                 type: integer
 *                           confidence:
 *                             type: number
 *       400:
 *         description: No faces detected atau file tidak valid
 */
router.post('/activation/upload-face', authenticateToken, upload.single('reference'), async (req, res) => {
  const connection = await getConnection();
  
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No image file provided',
        code: 'NO_FILE'
      });
    }

    const imagePath = req.file.path;
    
    // Detect faces using AI
    const faces = await detectFaces(imagePath);
    
    if (faces.length === 0) {
      // Delete uploaded file if no faces detected
      await discardUploadedFile(req.file);
      return res.status(400).json({
        success: false,
        message: 'No faces detected in the image',
        code: 'NO_FACES'
      });
    }

    // Deactivate existing reference photos for this employee (v2)
    await connection.execute(
      'UPDATE karyawan_face_reference SET is_active = FALSE WHERE id_karyawan = ?',
      [req.user.id]
    );

    const storedPhotoPath = await persistUploadedFile(req.file, { folder: 'uploads/karyawan' });

    // Save new reference photo to database
    const [result] = await connection.execute(`
      INSERT INTO karyawan_face_reference
      (id_karyawan, face_encoding, photo_path, is_active, enrollment_method)
      VALUES (?, ?, ?, TRUE, 'manual')
    `, [
      req.user.id,
      JSON.stringify(faces[0]), // Save first face encoding
      storedPhotoPath
    ]);

    await connection.execute(
      'UPDATE karyawan SET face_enrollment_completed = TRUE WHERE id = ? AND deleted_at IS NULL',
      [req.user.id]
    );

    res.json({
      success: true,
      message: 'Reference photo uploaded successfully',
      data: {
        referenceId: result.insertId,
        filename: req.file.filename,
        originalName: req.file.originalname,
        facesDetected: faces.length,
        faces: faces
      }
    });

  } catch (error) {
    console.error('Upload face error:', error);
    
    // Delete uploaded file on error
    await discardUploadedFile(req.file);
    
    res.status(500).json({
      success: false,
      message: 'Failed to process reference image',
      code: 'PROCESSING_ERROR'
    });
  } finally {
    await connection.end();
  }
});

/**
 * @swagger
 * /api/activation/set-pin:
 *   post:
 *     tags: [Activation]
 *     summary: Set PIN untuk pertama kali
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
 *               - confirmPin
 *             properties:
 *               pin:
 *                 type: string
 *                 description: PIN 6 digit
 *                 example: "123456"
 *               confirmPin:
 *                 type: string
 *                 description: Konfirmasi PIN
 *                 example: "123456"
 *     responses:
 *       200:
 *         description: PIN berhasil di-set
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "PIN set successfully"
 *       400:
 *         description: PIN tidak valid atau tidak cocok
 */
router.post('/activation/set-pin', authenticateToken, async (req, res) => {
  const connection = await getConnection();
  
  try {
    const { pin, confirmPin } = req.body;

    if (!pin || !confirmPin) {
      return res.status(400).json({
        success: false,
        message: 'PIN and confirm PIN are required',
        code: 'MISSING_PIN'
      });
    }

    if (pin !== confirmPin) {
      return res.status(400).json({
        success: false,
        message: 'PIN and confirm PIN do not match',
        code: 'PIN_MISMATCH'
      });
    }

    if (pin.length !== 6 || !/^\d{6}$/.test(pin)) {
      return res.status(400).json({
        success: false,
        message: 'PIN must be exactly 6 digits',
        code: 'INVALID_PIN_FORMAT'
      });
    }

    // Check if PIN is already set
    const [rows] = await connection.execute(
      'SELECT pin_hash FROM karyawan WHERE id = ? AND deleted_at IS NULL',
      [req.user.id]
    );

    if (rows.length > 0 && rows[0].pin_hash) {
      return res.status(400).json({
        success: false,
        message: 'PIN is already set',
        code: 'PIN_ALREADY_SET'
      });
    }

    // Hash PIN
    const hashedPin = await bcrypt.hash(pin, 10);

    // Update PIN in database (v2)
    await connection.execute(
      'UPDATE karyawan SET pin_hash = ? WHERE id = ? AND deleted_at IS NULL',
      [hashedPin, req.user.id]
    );

    res.json({
      success: true,
      message: 'PIN set successfully'
    });

  } catch (error) {
    console.error('Set PIN error:', error);
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
 * /api/pin/change:
 *   post:
 *     tags: [PIN Management]
 *     summary: Change PIN
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - current_pin
 *               - new_pin
 *             properties:
 *               current_pin:
 *                 type: string
 *                 description: Current PIN
 *                 example: "1234"
 *               new_pin:
 *                 type: string
 *                 description: New PIN (6 digits)
 *                 example: "5678"
 *     responses:
 *       200:
 *         description: PIN changed successfully
 *       400:
 *         description: Invalid PIN format or current PIN incorrect
 *       401:
 *         description: Current PIN is incorrect
 */
router.post('/pin/change', authenticateToken, async (req, res) => {
  const connection = await getConnection();
  
  try {
    const { current_pin, new_pin } = req.body;

    if (!current_pin || !new_pin) {
      return res.status(400).json({
        success: false,
        message: 'Current PIN and new PIN are required',
        code: 'MISSING_PIN'
      });
    }

    // Validate new PIN format (6 digits)
    if (new_pin.length !== 6 || !/^\d{6}$/.test(new_pin)) {
      return res.status(400).json({
        success: false,
        message: 'New PIN must be exactly 6 digits',
        code: 'INVALID_PIN_FORMAT'
      });
    }

    // Get current PIN from database
    const [rows] = await connection.execute(
      'SELECT pin_hash FROM karyawan WHERE id = ? AND deleted_at IS NULL',
      [req.user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found',
        code: 'EMPLOYEE_NOT_FOUND'
      });
    }

    const karyawan = rows[0];

    // Verify current PIN
    const isPinValid = await bcrypt.compare(current_pin, karyawan.pin_hash);
    
    if (!isPinValid) {
      return res.status(401).json({
        success: false,
        message: 'Current PIN is incorrect',
        code: 'INVALID_CURRENT_PIN'
      });
    }

    // Hash new PIN
    const hashedNewPin = await bcrypt.hash(new_pin, 10);

    // Update PIN in database (v2)
    await connection.execute(
      'UPDATE karyawan SET pin_hash = ? WHERE id = ? AND deleted_at IS NULL',
      [hashedNewPin, req.user.id]
    );

    res.json({
      success: true,
      message: 'PIN changed successfully',
      data: {
        changed_at: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Change PIN error:', error);
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
 * /api/activation/complete:
 *   post:
 *     tags: [Activation]
 *     summary: Selesaikan proses aktivasi akun
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Aktivasi berhasil diselesaikan
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Account activation completed successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     accessToken:
 *                       type: string
 *                       description: New access token for activated account
 *       400:
 *         description: Aktivasi belum lengkap (PIN atau foto referensi belum di-set)
 */
router.post('/activation/complete', authenticateToken, async (req, res) => {
  const connection = await getConnection();
  
  try {
    // Check if PIN is set
    const [karyawanRows] = await connection.execute(
      `SELECT
        e.email,
        e.pin_hash AS pin,
        e.email_verified_at
      FROM karyawan e
      WHERE e.id = ? AND e.deleted_at IS NULL`,
      [req.user.id]
    );

    if (!karyawanRows[0].pin) {
      return res.status(400).json({
        success: false,
        message: 'PIN must be set before completing activation',
        code: 'PIN_NOT_SET'
      });
    }

    // Check if face reference is uploaded
    const [faceRows] = await connection.execute(
      'SELECT id FROM karyawan_face_reference WHERE id_karyawan = ? AND is_active = TRUE',
      [req.user.id]
    );

    if (faceRows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Face reference must be uploaded before completing activation',
        code: 'FACE_REFERENCE_NOT_SET'
      });
    }

    if (karyawanRows[0].email && !karyawanRows[0].email_verified_at) {
      return res.status(400).json({
        success: false,
        message: 'Email must be verified before completing activation',
        code: 'EMAIL_NOT_VERIFIED'
      });
    }

    // Mark account as activated
    await connection.execute(
      "UPDATE karyawan SET status = 'active' WHERE id = ? AND deleted_at IS NULL",
      [req.user.id]
    );

    // Generate new access token without needsActivation flag
    const accessToken = generateAccessToken({ 
      id: req.user.id, 
      nik: req.user.nik 
    });

    res.json({
      success: true,
      message: 'Account activation completed successfully',
      data: {
        accessToken
      }
    });

  } catch (error) {
    console.error('Complete activation error:', error);
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
 *     summary: Get employee face reference photo
 *     tags: [Face Recognition]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Face reference retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Face reference retrieved"
 *                 data:
 *                   type: object
 *                   properties:
 *                     has_reference:
 *                       type: boolean
 *                       example: true
 *                     photo_url:
 *                       type: string
 *                       example: "/uploads/faces/employee_1_face.jpg"
 *                     upload_date:
 *                       type: string
 *                       format: date-time
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 */
router.get('/employee/face-reference', authenticateToken, async (req, res) => {
  const connection = await getConnection();

  try {
    const [rows] = await connection.execute(`
      SELECT id, photo_path, created_at
      FROM karyawan_face_reference
      WHERE id_karyawan = ? AND is_active = TRUE
      ORDER BY created_at DESC
      LIMIT 1
    `, [req.user.id]);

    if (!rows.length) {
      return res.json({
        success: true,
        data: {
          has_reference: false,
          photo_url: null,
          upload_date: null
        }
      });
    }

    res.json({
      success: true,
      data: {
        has_reference: true,
          photo_url: rows[0].photo_path,
        upload_date: rows[0].created_at
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
 * /api/face/status:
 *   get:
 *     summary: Get face recognition status
 *     tags: [Face Recognition]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Face recognition status retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Face recognition status retrieved"
 *                 data:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       example: true
 *                     has_reference:
 *                       type: boolean
 *                       example: true
 *                     enrollment_completed:
 *                       type: boolean
 *                       example: true
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 */
router.get('/face/status', authenticateToken, async (req, res) => {
  const connection = await getConnection();

  try {
    const [faceRows] = await connection.execute(
      'SELECT COUNT(*) AS count FROM karyawan_face_reference WHERE id_karyawan = ? AND is_active = TRUE',
      [req.user.id]
    );

    const [secRows] = await connection.execute(
      'SELECT face_enrollment_completed FROM karyawan WHERE id = ? LIMIT 1',
      [req.user.id]
    );

    const hasReference = Number(faceRows[0].count) > 0;
    const enrollmentCompleted = secRows.length ? !!secRows[0].face_enrollment_completed : hasReference;

    res.json({
      success: true,
      data: {
        enabled: true,
        has_reference: hasReference,
        enrollment_completed: enrollmentCompleted
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
 * /api/face/re-enroll:
 *   post:
 *     summary: Re-enroll face reference (update existing face)
 *     tags: [Face Recognition]
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
 *                 example: "1234"
 *               face_photo:
 *                 type: string
 *                 format: binary
 *                 description: New face photo
 *     responses:
 *       200:
 *         description: Face re-enrollment successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Face re-enrollment successful"
 *                 data:
 *                   type: object
 *                   properties:
 *                     faces_detected:
 *                       type: integer
 *                       example: 1
 *                     reference_id:
 *                       type: integer
 *                       example: 5
 *                     old_photo:
 *                       type: string
 *                       example: "/uploads/faces/old_photo.jpg"
 *                     new_photo:
 *                       type: string
 *                       example: "/uploads/faces/new_photo.jpg"
 *                     updated_at:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: Invalid PIN or no face detected
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 */
router.post('/face/re-enroll', authenticateToken, upload.single('face_photo'), async (req, res) => {
  const connection = await getConnection();

  try {
    const { current_pin } = req.body;

    if (!current_pin) {
      await discardUploadedFile(req.file);
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

    const [secRows] = await connection.execute(
      'SELECT pin_hash FROM karyawan WHERE id = ? LIMIT 1',
      [req.user.id]
    );

    if (!secRows.length || !secRows[0].pin_hash) {
      await discardUploadedFile(req.file);
      return res.status(400).json({
        success: false,
        message: 'PIN not set for this employee',
        code: 'PIN_NOT_SET'
      });
    }

    const isPinValid = await bcrypt.compare(current_pin, secRows[0].pin_hash);
    if (!isPinValid) {
      await discardUploadedFile(req.file);
      return res.status(401).json({
        success: false,
        message: 'Current PIN is incorrect',
        code: 'INVALID_PIN'
      });
    }

    const faces = await detectFaces(req.file.path);
    if (!faces.length) {
      await discardUploadedFile(req.file);
      return res.status(400).json({
        success: false,
        message: 'No faces detected in the image',
        code: 'NO_FACES'
      });
    }

    await connection.execute(
      'UPDATE karyawan_face_reference SET is_active = FALSE WHERE id_karyawan = ?',
      [req.user.id]
    );

    const storedPhotoPath = await persistUploadedFile(req.file, { folder: 'uploads/karyawan' });

    const [insertResult] = await connection.execute(`
      INSERT INTO karyawan_face_reference (id_karyawan, face_encoding, photo_path, enrollment_method, is_active)
      VALUES (?, ?, ?, 'manual', TRUE)
    `, [
      req.user.id,
      JSON.stringify(faces[0]),
      storedPhotoPath
    ]);

    await connection.execute(
      'UPDATE karyawan SET face_enrollment_completed = TRUE WHERE id = ? AND deleted_at IS NULL',
      [req.user.id]
    );

    res.json({
      success: true,
      message: 'Face re-enrollment successful',
      data: {
        reference_id: insertResult.insertId,
        faces_detected: faces.length,
        updated_at: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Face re-enroll error:', error);
    await discardUploadedFile(req.file);
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
 * /api/leave-requests:
 *   get:
 *     tags: [Absensi]
 *     summary: Ambil daftar pengajuan cuti/izin/sakit milik user login
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Daftar pengajuan berhasil diambil
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       jenis:
 *                         type: string
 *                         enum: [cuti, izin, sakit]
 *                       kategori:
 *                         type: string
 *                         enum: [full_day, half_day, hourly]
 *                       tanggal_mulai:
 *                         type: string
 *                         format: date
 *                       tanggal_selesai:
 *                         type: string
 *                         format: date
 *                       jam_mulai:
 *                         type: string
 *                         nullable: true
 *                       jam_selesai:
 *                         type: string
 *                         nullable: true
 *                       durasi_menit:
 *                         type: integer
 *                       status:
 *                         type: string
 *                         enum: [menunggu_pengganti, menunggu_manager, disetujui, ditolak, ditolak_pengganti, dibatalkan]
 */
router.get('/leave-requests', authenticateToken, async (req, res) => {
  const connection = await getConnection();

  try {
    const [rows] = await connection.execute(`
      SELECT
        lr.id,
        lr.id_karyawan AS id_karyawan,
        lr.jenis AS jenis,
        lr.leave_type AS leave_type,
        lr.kategori AS kategori,
        lr.tanggal_mulai AS tanggal_mulai,
        lr.tanggal_selesai AS tanggal_selesai,
        lr.jam_mulai AS jam_mulai,
        lr.jam_selesai AS jam_selesai,
        lr.durasi_menit AS durasi_menit,
        lr.alasan AS alasan,
        lr.lampiran AS lampiran,
        pa.id_pengganti,
        pengganti.nama AS nama_pengganti,
        pa.catatan AS catatan_pengganti,
        CASE WHEN pa.status = 'disetujui' THEN pa.updated_at ELSE NULL END AS approved_pengganti_at,
        lr.status,
        lr.approval_notes,
        lr.approved_at,
        lr.created_at,
        lr.updated_at
      FROM absensi lr
      LEFT JOIN permintaan_absensi pa ON pa.id_absensi = lr.id
      LEFT JOIN karyawan pengganti ON pa.id_pengganti = pengganti.id
      WHERE lr.id_karyawan = ?
      ORDER BY lr.created_at DESC
    `, [req.user.id]);

    res.json({
      success: true,
      message: 'Leave requests retrieved successfully',
      data: rows
    });
  } catch (error) {
    console.error('Leave request list error:', error);
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
 * /api/replacement-candidates:
 *   get:
 *     tags: [Absensi]
 *     summary: Ambil daftar karyawan aktif untuk pilihan pengganti
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: false
 *         schema:
 *           type: string
 *         description: Cari berdasarkan nama, NIK, atau jabatan
 *     responses:
 *       200:
 *         description: Daftar kandidat pengganti berhasil diambil
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       nik:
 *                         type: string
 *                       nama:
 *                         type: string
 *                       nama_jabatan:
 *                         type: string
 *                         nullable: true
 */
router.get('/replacement-candidates', authenticateToken, async (req, res) => {
  const connection = await getConnection();

  try {
    const q = (req.query.q || '').toString().trim();
    const params = [req.user.id];
    let searchSql = '';

    if (q) {
      searchSql = `
        AND (
          e.nama LIKE ?
          OR e.nik LIKE ?
          OR COALESCE(j.nama_jabatan, '') LIKE ?
        )
      `;
      const likeQ = `%${q}%`;
      params.push(likeQ, likeQ, likeQ);
    }

    const [rows] = await connection.execute(`
      SELECT
        e.id,
        e.nik,
        e.nama,
        j.nama_jabatan
      FROM karyawan e
      LEFT JOIN jabatan j ON j.id = e.id_jabatan
      WHERE e.deleted_at IS NULL
        AND e.status = 'active'
        AND e.id <> ?
        ${searchSql}
      ORDER BY e.nama ASC
      LIMIT 100
    `, params);

    res.json({
      success: true,
      message: 'Replacement candidates retrieved successfully',
      data: rows
    });
  } catch (error) {
    console.error('Replacement candidates error:', error);
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
 * /api/leave-requests:
 *   post:
 *     tags: [Absensi]
 *     summary: Ajukan cuti/izin/sakit baru
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [jenis, tanggal_mulai, tanggal_selesai, alasan]
 *             properties:
 *               jenis:
 *                 type: string
 *                 enum: [cuti, izin, sakit]
 *               leave_type:
 *                 type: string
 *                 enum: [planned, urgent]
 *                 description: "Tipe pengajuan. 'planned' WAJIB mengisi id_pengganti (perlu ACC pengganti lalu manager). 'urgent' langsung ke manager; pengganti ditentukan manager setelah disetujui. Bila tidak dikirim, disimpulkan dari ada/tidaknya id_pengganti (backward-compatible)."
 *               kategori:
 *                 type: string
 *                 enum: [full_day, half_day, hourly]
 *                 description: "Opsional. Bila tidak dikirim, ditentukan otomatis dari jam - ada jam_mulai & jam_selesai maka 'hourly' (izin sebagian), kosong maka 'full_day' (seharian)."
 *               tanggal_mulai:
 *                 type: string
 *                 format: date
 *               tanggal_selesai:
 *                 type: string
 *                 format: date
 *               jam_mulai:
 *                 type: string
 *                 nullable: true
 *                 example: "09:00"
 *                 description: "Isi untuk izin sebagian (per-jam); kosongkan untuk seharian."
 *               jam_selesai:
 *                 type: string
 *                 nullable: true
 *                 example: "11:00"
 *                 description: "Wajib bila jam_mulai diisi, dan harus lebih besar dari jam_mulai."
 *               id_pengganti:
 *                 type: integer
 *                 nullable: true
 *                 description: "ID karyawan pengganti. WAJIB untuk leave_type 'planned' (status awal 'menunggu_pengganti', perlu ACC pengganti lalu manager). DILARANG untuk 'urgent' (pengganti ditentukan manager setelah disetujui)."
 *               alasan:
 *                 type: string
 *               lampiran:
 *                 type: string
 *                 format: binary
 *                 description: Wajib untuk jenis sakit. Opsional untuk izin.
 *     responses:
 *       201:
 *         description: Pengajuan berhasil dibuat
 *       400:
 *         description: "Data tidak lengkap/valid. Kode - INVALID_LEAVE_TYPE, INVALID_LEAVE_REQUEST_TYPE (leave_type bukan planned/urgent), REPLACEMENT_REQUIRED_FOR_PLANNED (planned tanpa pengganti), SUBSTITUTE_NOT_ALLOWED_FOR_URGENT (urgent pilih pengganti sendiri), MISSING_PARTIAL_TIME, INVALID_PARTIAL_TIME, INVALID_DATE_RANGE, REPLACEMENT_NOT_FOUND."
 *       409:
 *         description: Tanggal pengajuan tumpang tindih dengan pengajuan lain yang masih aktif
 */
router.post('/leave-requests', authenticateToken, leaveUpload.single('lampiran'), async (req, res) => {
  const connection = await getConnection();

  try {
    const {
      jenis,
      leave_type,
      kategori,
      tanggal_mulai,
      tanggal_selesai,
      jam_mulai,
      jam_selesai,
      alasan,
      id_pengganti
    } = req.body;

    const normalizedJenis = (jenis || '').toLowerCase();
    if (!['cuti', 'izin', 'sakit'].includes(normalizedJenis)) {
      await discardUploadedFile(req.file);
      return res.status(400).json({
        success: false,
        message: 'Jenis harus cuti, izin, atau sakit',
        code: 'INVALID_LEAVE_TYPE'
      });
    }

    if (!tanggal_mulai || !tanggal_selesai || !alasan) {
      await discardUploadedFile(req.file);
      return res.status(400).json({
        success: false,
        message: 'Jenis, tanggal, dan alasan wajib diisi',
        code: 'MISSING_LEAVE_DATA'
      });
    }

    // Izin MENDADAK (urgent) tidak wajib lampiran — surat keterangan sakit hanya diwajibkan
    // untuk pengajuan terencana (planned), karena yang mendadak tak sempat menyiapkan surat.
    const isUrgentLeave = (leave_type || '').toString().toLowerCase().trim() === 'urgent';
    if (normalizedJenis === 'sakit' && !isUrgentLeave && !req.file) {
      return res.status(400).json({
        success: false,
        message: 'Surat keterangan sakit wajib dilampirkan',
        code: 'SICK_NOTE_REQUIRED'
      });
    }

    // Validasi tanggal tidak tumpang tindih dengan pengajuan lain yang masih aktif
    const [overlapRows] = await connection.execute(
      `SELECT id FROM absensi
       WHERE id_karyawan = ?
         AND status NOT IN ('ditolak', 'ditolak_pengganti', 'dibatalkan')
         AND tanggal_mulai <= ?
         AND tanggal_selesai >= ?
       LIMIT 1`,
      [req.user.id, tanggal_selesai, tanggal_mulai]
    );
    if (overlapRows.length) {
      await discardUploadedFile(req.file);
      return res.status(409).json({
        success: false,
        message: 'Tanggal pengajuan tumpang tindih dengan pengajuan lain yang masih aktif',
        code: 'LEAVE_DATE_OVERLAP'
      });
    }

    // Sinkron dengan form: kategori ditentukan dari ada/tidaknya jam.
    //   jam diisi  -> izin per-jam (partial, durasi = selisih jam)
    //   jam kosong -> izin seharian (full_day)
    // kategori eksplisit (mis. dari web) tetap dihormati bila dikirim.
    const hasPartialTime = !!(jam_mulai && jam_selesai);
    const normalizedCategory = kategori || (hasPartialTime ? 'hourly' : 'full_day');
    const replacementId = id_pengganti ? Number.parseInt(id_pengganti, 10) : null;
    if (replacementId && replacementId === req.user.id) {
      await discardUploadedFile(req.file);
      return res.status(400).json({
        success: false,
        message: 'Karyawan pengganti tidak boleh sama dengan pengaju',
        code: 'INVALID_REPLACEMENT_EMPLOYEE'
      });
    }

    if (replacementId) {
      const [replacementRows] = await connection.execute(
        `SELECT id FROM karyawan WHERE id = ? AND status = 'active' AND deleted_at IS NULL LIMIT 1`,
        [replacementId]
      );
      if (replacementRows.length === 0) {
        await discardUploadedFile(req.file);
        return res.status(400).json({
          success: false,
          message: 'Karyawan pengganti tidak ditemukan atau tidak aktif',
          code: 'REPLACEMENT_NOT_FOUND'
        });
      }
    }

    // Tipe pengajuan: 'planned' (pengganti dipilih pengaju -> perlu ACC pengganti dulu, baru manager)
    // atau 'urgent' (langsung ke manager; pengganti ditentukan manager setelah disetujui).
    // Backward-compatible: bila leave_type tidak dikirim (klien lama), disimpulkan dari ada/tidaknya
    // pengganti sehingga perilaku lama tidak berubah.
    const rawLeaveType = (leave_type || '').toString().toLowerCase().trim();
    let normalizedLeaveType;
    if (rawLeaveType) {
      if (!['planned', 'urgent'].includes(rawLeaveType)) {
        await discardUploadedFile(req.file);
        return res.status(400).json({
          success: false,
          message: 'Tipe pengajuan harus planned atau urgent',
          code: 'INVALID_LEAVE_REQUEST_TYPE'
        });
      }
      normalizedLeaveType = rawLeaveType;
      if (normalizedLeaveType === 'planned' && !replacementId) {
        await discardUploadedFile(req.file);
        return res.status(400).json({
          success: false,
          message: 'Planned leave wajib memilih karyawan pengganti',
          code: 'REPLACEMENT_REQUIRED_FOR_PLANNED'
        });
      }
      if (normalizedLeaveType === 'urgent' && replacementId) {
        await discardUploadedFile(req.file);
        return res.status(400).json({
          success: false,
          message: 'Urgent leave tidak boleh memilih pengganti sendiri; pengganti ditentukan Manager',
          code: 'SUBSTITUTE_NOT_ALLOWED_FOR_URGENT'
        });
      }
    } else {
      normalizedLeaveType = replacementId ? 'planned' : 'urgent';
    }

    const initialStatus = normalizedLeaveType === 'planned' ? 'menunggu_pengganti' : 'menunggu_manager';
    let lampiranPath = null;
    let durationMinutes = 0;
    if (normalizedCategory === 'hourly' || normalizedCategory === 'half_day') {
      if (!jam_mulai || !jam_selesai) {
        await discardUploadedFile(req.file);
        return res.status(400).json({
          success: false,
          message: 'Jam mulai dan jam selesai wajib diisi untuk izin parsial',
          code: 'MISSING_PARTIAL_TIME'
        });
      }
      durationMinutes = calculateLeaveMinutes({
        status: 'approved',
        jam_mulai,
        jam_selesai
      });
      if (!durationMinutes || durationMinutes <= 0) {
        await discardUploadedFile(req.file);
        return res.status(400).json({
          success: false,
          message: 'Jam selesai harus lebih besar dari jam mulai',
          code: 'INVALID_PARTIAL_TIME'
        });
      }
    } else {
      const startDate = new Date(`${tanggal_mulai}T00:00:00`);
      const endDate = new Date(`${tanggal_selesai}T00:00:00`);
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate < startDate) {
        await discardUploadedFile(req.file);
        return res.status(400).json({
          success: false,
          message: 'Rentang tanggal tidak valid',
          code: 'INVALID_DATE_RANGE'
        });
      }
      // Sesuai kebutuhan saat ini: 12 -> 13 dihitung 1 hari
      const daySpan = Math.max(1, Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24)));
      durationMinutes = daySpan * 8 * 60;
    }

    lampiranPath = req.file ? await persistUploadedFile(req.file, { folder: 'uploads/leave' }) : null;

    const [result] = await connection.execute(`
      INSERT INTO absensi (
        id_karyawan, jenis, leave_type, kategori, tanggal_mulai, tanggal_selesai,
        jam_mulai, jam_selesai, durasi_menit, alasan, lampiran, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      req.user.id,
      normalizedJenis,
      normalizedLeaveType,
      normalizedCategory,
      tanggal_mulai,
      tanggal_selesai,
      jam_mulai || null,
      jam_selesai || null,
      durationMinutes,
      alasan,
      lampiranPath,
      initialStatus
    ]);

    // Bikin permintaan_absensi kalau ada pengganti
    if (replacementId && result.insertId) {
      await connection.execute(`
        INSERT INTO permintaan_absensi (id_absensi, id_pengganti, id_pemohon, status)
        VALUES (?, ?, ?, 'menunggu')
      `, [result.insertId, replacementId, req.user.id]);
    }

    res.status(201).json({
      success: true,
      message: replacementId
        ? 'Pengajuan Absensi berhasil dikirim dan menunggu persetujuan pengganti'
        : 'Pengajuan Absensi berhasil dikirim dan menunggu persetujuan manager',
      data: {
        id: result.insertId,
        leave_type: normalizedLeaveType,
        status: initialStatus,
        durasi_menit: durationMinutes
      }
    });
  } catch (error) {
    console.error('Create leave request error:', error);
    await discardUploadedFile(req.file);
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
 * /api/leave-requests/{id}/cancel:
 *   put:
 *     tags: [Absensi]
 *     summary: Batalkan pengajuan Absensi milik karyawan yang masih menunggu
 *     description: Karyawan dapat membatalkan pengajuannya sendiri selama belum diproses (disetujui/ditolak). Status pengajuan menjadi "dibatalkan".
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID pengajuan absensi
 *     responses:
 *       200:
 *         description: Pengajuan berhasil dibatalkan
 *       404:
 *         description: Pengajuan tidak ditemukan
 *       409:
 *         description: Pengajuan sudah diproses dan tidak dapat dibatalkan
 */
router.put('/leave-requests/:id/cancel', authenticateToken, async (req, res) => {
  const connection = await getConnection();

  try {
    const leaveId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(leaveId) || leaveId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'ID pengajuan tidak valid',
        code: 'INVALID_LEAVE_ID'
      });
    }

    const [rows] = await connection.execute(
      `SELECT id, status FROM absensi WHERE id = ? AND id_karyawan = ? LIMIT 1`,
      [leaveId, req.user.id]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: 'Pengajuan absensi tidak ditemukan',
        code: 'LEAVE_NOT_FOUND'
      });
    }

    // Hanya pengajuan yang belum diputus manager yang boleh dibatalkan karyawan
    const cancellableStatuses = ['pending', 'menunggu_pengganti', 'menunggu_manager'];
    if (!cancellableStatuses.includes(rows[0].status)) {
      return res.status(409).json({
        success: false,
        message: 'Pengajuan yang sudah diproses tidak dapat dibatalkan',
        code: 'LEAVE_NOT_CANCELLABLE'
      });
    }

    await connection.execute(
      `UPDATE absensi SET status = 'dibatalkan' WHERE id = ? AND id_karyawan = ?`,
      [leaveId, req.user.id]
    );

    // Tutup permintaan pengganti yang masih menunggu agar tidak muncul ke calon pengganti
    await connection.execute(
      `UPDATE permintaan_absensi SET status = 'ditolak' WHERE id_absensi = ? AND status = 'menunggu'`,
      [leaveId]
    );

    return res.json({
      success: true,
      message: 'Pengajuan absensi berhasil dibatalkan',
      data: { id: leaveId, status: 'dibatalkan' }
    });
  } catch (error) {
    console.error('Cancel leave request error:', error);
    return res.status(500).json({
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
 * /api/replacement-requests:
 *   get:
 *     tags: [Absensi]
 *     summary: Ambil daftar pengajuan Absensi yang meminta user login sebagai pengganti
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Daftar pengajuan pengganti berhasil diambil
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 */
router.get('/replacement-requests', authenticateToken, async (req, res) => {
  const connection = await getConnection();

  try {
    const [rows] = await connection.execute(`
      SELECT
        lr.id,
        lr.id_karyawan,
        pengaju.nama AS nama_karyawan,
        pengaju.nik,
        lr.jenis,
        lr.leave_type,
        lr.kategori,
        lr.tanggal_mulai,
        lr.tanggal_selesai,
        lr.jam_mulai,
        lr.jam_selesai,
        lr.durasi_menit,
        lr.alasan,
        lr.lampiran,
        lr.status,
        pa.catatan AS catatan_pengganti,
        CASE WHEN pa.status = 'disetujui' THEN pa.updated_at ELSE NULL END AS approved_pengganti_at,
        pa.status AS status_pengganti,
        pa.id AS id_permintaan,
        lr.created_at
      FROM permintaan_absensi pa
      JOIN absensi lr ON lr.id = pa.id_absensi
      JOIN karyawan pengaju ON pengaju.id = lr.id_karyawan
      WHERE pa.id_pengganti = ?
      ORDER BY lr.created_at DESC
    `, [req.user.id]);

    res.json({
      success: true,
      message: 'Replacement requests retrieved successfully',
      data: rows
    });
  } catch (error) {
    console.error('Replacement request list error:', error);
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
 * /api/replacement-requests/pending-count:
 *   get:
 *     tags: [Absensi]
 *     summary: Jumlah permintaan pengganti yang masih menunggu keputusan user login
 *     description: Dipakai untuk badge/notifikasi di beranda (mis. app Android) menuju halaman cek approval pengganti.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Jumlah permintaan pengganti menunggu
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     pending: { type: integer, example: 2 }
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 */
router.get('/replacement-requests/pending-count', authenticateToken, async (req, res) => {
  const connection = await getConnection();
  try {
    // Hitung tugas pengganti yang perlu perhatian di beranda:
    //  - planned yang masih menunggu keputusan user (perlu ACC/tolak), DAN
    //  - urgent yang sudah DISETUJUI manager & user ditunjuk sebagai pengganti (info: wajib hadir),
    //    selama tanggalnya belum lewat.
    const [rows] = await connection.execute(
      `SELECT COUNT(*) AS pending
       FROM permintaan_absensi pa
       JOIN absensi a ON a.id = pa.id_absensi
       WHERE pa.id_pengganti = ?
         AND (
           pa.status = 'menunggu'
           OR (pa.status = 'disetujui' AND a.leave_type = 'urgent'
               AND a.status = 'disetujui' AND a.tanggal_selesai >= CURDATE())
         )`,
      [req.user.id]
    );
    res.json({
      success: true,
      message: 'Pending replacement count retrieved successfully',
      data: { pending: Number(rows[0]?.pending || 0) }
    });
  } catch (error) {
    console.error('Pending replacement count error:', error);
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
 * /api/replacement-requests/{id}/approve:
 *   post:
 *     tags: [Absensi]
 *     summary: Setujui permintaan menjadi karyawan pengganti
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID pengajuan Absensi
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               catatan_pengganti:
 *                 type: string
 *                 nullable: true
 *     responses:
 *       200:
 *         description: Permintaan pengganti berhasil disetujui
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       409:
 *         description: Permintaan tidak ditemukan atau sudah diproses
 */
router.post('/replacement-requests/:id/approve', authenticateToken, async (req, res) => {
  const connection = await getConnection();

  try {
    const { catatan_pengganti } = req.body;
    await connection.beginTransaction();
    const [paResult] = await connection.execute(`
      UPDATE permintaan_absensi
      SET status = 'disetujui',
          catatan = COALESCE(?, catatan)
      WHERE id_absensi = ?
        AND id_pengganti = ?
        AND status = 'menunggu'
    `, [catatan_pengganti || null, req.params.id, req.user.id]);

    if (paResult.affectedRows === 0) {
      await connection.rollback();
      return res.status(409).json({
        success: false,
        message: 'Permintaan pengganti tidak ditemukan atau sudah diproses',
        code: 'REPLACEMENT_REQUEST_NOT_AVAILABLE'
      });
    }

    // Cascade: absensi.status menunggu_pengganti → menunggu_manager
    await connection.execute(`
      UPDATE absensi SET status = 'menunggu_manager'
      WHERE id = ? AND status = 'menunggu_pengganti'
    `, [req.params.id]);

    await connection.commit();

    res.json({
      success: true,
      message: 'Permintaan pengganti berhasil disetujui'
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    console.error('Approve replacement request error:', error);
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
 * /api/replacement-requests/{id}/reject:
 *   post:
 *     tags: [Absensi]
 *     summary: Tolak permintaan menjadi karyawan pengganti
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID pengajuan Absensi
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               catatan_pengganti:
 *                 type: string
 *                 nullable: true
 *     responses:
 *       200:
 *         description: Permintaan pengganti berhasil ditolak
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       409:
 *         description: Permintaan tidak ditemukan atau sudah diproses
 */
router.post('/replacement-requests/:id/reject', authenticateToken, async (req, res) => {
  const connection = await getConnection();

  try {
    const { catatan_pengganti } = req.body;
    await connection.beginTransaction();
    const [paResult] = await connection.execute(`
      UPDATE permintaan_absensi
      SET status = 'ditolak',
          catatan = COALESCE(?, catatan)
      WHERE id_absensi = ?
        AND id_pengganti = ?
        AND status = 'menunggu'
    `, [catatan_pengganti || null, req.params.id, req.user.id]);

    if (paResult.affectedRows === 0) {
      await connection.rollback();
      return res.status(409).json({
        success: false,
        message: 'Permintaan pengganti tidak ditemukan atau sudah diproses',
        code: 'REPLACEMENT_REQUEST_NOT_AVAILABLE'
      });
    }

    // Cascade: absensi.status menunggu_pengganti → ditolak_pengganti
    await connection.execute(`
      UPDATE absensi SET status = 'ditolak_pengganti'
      WHERE id = ? AND status = 'menunggu_pengganti'
    `, [req.params.id]);

    await connection.commit();

    res.json({
      success: true,
      message: 'Permintaan pengganti berhasil ditolak'
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    console.error('Reject replacement request error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'SERVER_ERROR'
    });
  } finally {
    await connection.end();
  }
});

// ============================================
// PRESENSI APIs
// Endpoint untuk clock in, clock out, dan riwayat presensi
// ============================================

/**
 * @swagger
 * /api/schedule/today/{id_karyawan}:
 *   get:
 *     tags: [Presensi]
 *     summary: Get jadwal kerja hari ini untuk karyawan
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id_karyawan
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID karyawan
 *     responses:
 *       200:
 *         description: Jadwal kerja hari ini
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     hasSchedule:
 *                       type: boolean
 *                     today:
 *                       type: string
 *                       example: "monday"
 *                     schedule:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: integer
 *                         name:
 *                           type: string
 *                         start_time:
 *                           type: string
 *                         end_time:
 *                           type: string
 *                         clock_in_start:
 *                           type: string
 *                         clock_in_end:
 *                           type: string
 *                         clock_out_start:
 *                           type: string
 *                         clock_out_end:
 *                           type: string
 *                         work_days:
 *                           type: array
 *                           items:
 *                             type: string
 */
router.get('/schedule/today/:id_karyawan', authenticateToken, async (req, res) => {
  const connection = await getConnection();
  
  try {
    const { id_karyawan } = req.params;

    // Verify user can only access their own schedule
    if (parseInt(id_karyawan) !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied',
        code: 'ACCESS_DENIED'
      });
    }

    // Get today's day name
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();

    // Get employee's work schedule
    const [rows] = await connection.execute(`
      SELECT
        ws.id,
        ws.nama AS nama,
        s.jam_masuk AS jam_masuk,
        s.jam_keluar AS jam_keluar,
        ws.hari_kerja AS hari_kerja,
        s.id AS shift_id,
        s.nama_shift AS nama_shift,
        s.kode_shift AS kode_shift
      FROM karyawan e
      LEFT JOIN jadwal_kerja ws ON e.id_jadwal_kerja = ws.id
      LEFT JOIN shift s ON s.id = COALESCE(e.shift_id, ws.shift_id)
      WHERE e.id = ? AND (ws.is_active = TRUE OR ws.id IS NULL)
      LIMIT 1
    `, [id_karyawan]);

    if (rows.length === 0) {
      return res.json({
        success: true,
        data: {
          hasSchedule: false,
          today: today,
          schedule: null
        }
      });
    }

    const schedule = rows[0];
    const workDays = parseWorkDays(schedule.hari_kerja);
    // DEV bypass: in development, treat today as a work day so testing isn't blocked by jadwal
    const bypassScheduleValidation = await isDevScheduleBypassEnabled(connection);
    const hasWorkToday = bypassScheduleValidation ? true : workDays.includes(today);
    const leaveRequest = await getApprovedLeaveForDate(connection, id_karyawan, getCurrentDateWITA());
    const leaveMinutes = calculateLeaveMinutes(leaveRequest);
    const attendanceWindows = buildAttendanceWindows(schedule.jam_masuk, schedule.jam_keluar);

    res.json({
      success: true,
      data: {
        hasSchedule: true,
        hasWorkToday: hasWorkToday,
        today: today,
        approved_leave: leaveRequest ? {
          id: leaveRequest.id,
          jenis: leaveRequest.jenis,
          kategori: leaveRequest.kategori,
          durasi_menit: leaveMinutes,
          jam_mulai: leaveRequest.jam_mulai ?? leaveRequest.start_time,
          jam_selesai: leaveRequest.jam_selesai ?? leaveRequest.end_time
        } : null,
        schedule: {
          id: schedule.id,
          name: schedule.nama,
          start_time: schedule.jam_masuk,
          end_time: schedule.jam_keluar,
          clock_in_start: attendanceWindows.clock_in_start,
          clock_in_end: attendanceWindows.clock_in_end,
          clock_out_start: attendanceWindows.clock_out_start,
          clock_out_end: attendanceWindows.clock_out_end,
          work_days: workDays
        },
        shift: schedule.shift_id ? mapShiftRow({
          id: schedule.shift_id,
          nama_shift: schedule.nama_shift,
          kode_shift: schedule.kode_shift,
          jam_masuk: schedule.jam_masuk,
          jam_keluar: schedule.jam_keluar
        }) : null
      }
    });

  } catch (error) {
    console.error('Get schedule error:', error);
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
 * /api/attendance/validate-face:
 *   post:
 *     tags: [Presensi]
 *     summary: Validasi wajah real-time tanpa save (untuk preview)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - photo
 *             properties:
 *               photo:
 *                 type: string
 *                 format: binary
 *                 description: Frame dari camera untuk validasi
 *     responses:
 *       200:
 *         description: Validasi berhasil
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     facesDetected:
 *                       type: integer
 *                     isMatch:
 *                       type: boolean
 *                     similarity:
 *                       type: number
 *                     confidence:
 *                       type: string
 *                     threshold:
 *                       type: number
 */
router.post('/attendance/validate-face', authenticateToken, upload.single('photo'), async (req, res) => {
  const connection = await getConnection();
  
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Photo is required',
        code: 'NO_PHOTO'
      });
    }

    // Get employee's face reference
    const [faceRows] = await connection.execute(
      'SELECT * FROM karyawan_face_reference WHERE id_karyawan = ? AND is_active = TRUE',
      [req.user.id]
    );

    if (faceRows.length === 0) {
      // Delete uploaded file
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      
      return res.status(400).json({
        success: false,
        message: 'No face reference found',
        code: 'NO_FACE_REFERENCE'
      });
    }

    let referenceFaces;
    try {
      referenceFaces = extractReferenceFaces(faceRows);
    } catch (error) {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(500).json({
        success: false,
        message: 'Invalid face reference data',
        code: 'INVALID_FACE_DATA'
      });
    }

    // Detect faces in uploaded photo
    const detectedFaces = await detectFaces(req.file.path);

    // Delete uploaded file immediately (tidak perlu disimpan)
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    if (detectedFaces.length === 0) {
      return res.json({
        success: true,
        data: {
          facesDetected: 0,
          isMatch: false,
          similarity: 0,
          confidence: 'Rendah',
          threshold: 0.85,
          message: 'No face detected'
        }
      });
    }

    // Compare faces
    const matchResults = await compareFaces(referenceFaces, detectedFaces);
    const bestMatch = matchResults.find(result => result.isMatch);

    if (bestMatch) {
      res.json({
        success: true,
        data: {
          facesDetected: detectedFaces.length,
          isMatch: true,
          similarity: bestMatch.similarity,
          confidence: bestMatch.confidence,
          threshold: bestMatch.threshold,
          message: 'Face matched!'
        }
      });
    } else {
      // Ambil similarity tertinggi meskipun tidak match
      const highestSimilarity = Math.max(...matchResults.map(r => r.similarity));
      res.json({
        success: true,
        data: {
          facesDetected: detectedFaces.length,
          isMatch: false,
          similarity: highestSimilarity,
          confidence: matchResults[0].confidence,
          threshold: matchResults[0].threshold,
          message: 'Face does not match'
        }
      });
    }

  } catch (error) {
    console.error('Validate face error:', error);
    
    // Delete uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'SERVER_ERROR',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    await connection.end();
  }
});

/**
 * @swagger
 * /api/attendance/checkin:
 *   post:
 *     tags: [Presensi]
 *     summary: Clock in dengan foto dan lokasi
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - photo
 *               - latitude
 *               - longitude
 *             properties:
 *               photo:
 *                 type: string
 *                 format: binary
 *                 description: Foto untuk face recognition
 *               latitude:
 *                 type: number
 *                 description: Latitude lokasi
 *                 example: -6.200000
 *               longitude:
 *                 type: number
 *                 description: Longitude lokasi
 *                 example: 106.816666
 *     responses:
 *       200:
 *         description: Clock in berhasil
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Clock in successful"
 *                 data:
 *                   type: object
 *                   properties:
 *                     attendanceId:
 *                       type: integer
 *                     clockInTime:
 *                       type: string
 *                     status:
 *                       type: string
 *                       example: "on_time"
 *                     faceMatch:
 *                       type: object
 *                       properties:
 *                         isMatch:
 *                           type: boolean
 *                         similarity:
 *                           type: number
 *                         confidence:
 *                           type: string
 *       400:
 *         description: Validasi gagal (lokasi, wajah, atau jadwal)
 */
router.post('/attendance/checkin', (req, res, next) => {
  console.log('=== CHECKIN REQUEST RECEIVED ===');
  console.log('Headers:', req.headers);
  console.log('Content-Type:', req.get('content-type'));
  next();
}, authenticateToken, upload.array('photo', 5), async (req, res) => {
  const connection = await getConnection();

  try {
    // Multi-frame: collect all uploaded frames; req.file becomes the chosen (best) frame downstream.
    const frameFiles = Array.isArray(req.files) && req.files.length ? req.files : (req.file ? [req.file] : []);
    req.file = frameFiles[0] || null;

    console.log('=== CHECKIN REQUEST START ===');
    console.log('User ID:', req.user.id);
    console.log('Body:', req.body);
    console.log('File:', req.file ? {
      filename: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype,
      path: req.file.path
    } : 'No file', `(frames: ${frameFiles.length})`);

    const { latitude, longitude } = req.body;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Photo is required',
        code: 'NO_PHOTO'
      });
    }

    if (!latitude || !longitude) {
      return res.status(400).json({
        success: false,
        message: 'Location coordinates are required',
        code: 'NO_LOCATION'
      });
    }

    console.log('Step 1: Getting office location settings...');
    // Get office location settings
    const [settingsRows] = await connection.execute(
      `SELECT
        lat_kantor AS lat_kantor,
        long_kantor AS long_kantor,
        radius_meter
      FROM pengaturan
      LIMIT 1`
    );

    if (settingsRows.length === 0) {
      return res.status(500).json({
        success: false,
        message: 'Office location not configured',
        code: 'NO_OFFICE_LOCATION'
      });
    }

    const settings = settingsRows[0];
    console.log('Office settings:', settings);

    console.log('Step 2: Validating location...');
    // Validate location
    const locationValidation = isLocationValid(
      parseFloat(latitude),
      parseFloat(longitude),
      parseFloat(settings.lat_kantor),
      parseFloat(settings.long_kantor),
      settings.radius_meter
    );
    console.log('Location validation:', locationValidation);

    if (!locationValidation.isValid) {
      // Delete uploaded file
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      
      return res.status(400).json({
        success: false,
        message: 'Location is outside allowed area',
        code: 'LOCATION_INVALID',
        data: {
          distance: locationValidation.distance,
          allowedRadius: locationValidation.allowedRadius
        }
      });
    }

    console.log('Step 3: Getting employee face reference...');
    // Get employee's face reference
    const [faceRows] = await connection.execute(
      `SELECT
        id,
        id_karyawan AS id_karyawan,
        face_encoding,
        photo_path,
        is_active,
        enrollment_method,
        created_at,
        updated_at
      FROM karyawan_face_reference
      WHERE id_karyawan = ? AND is_active = TRUE`,
      [req.user.id]
    );

    if (faceRows.length === 0) {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      
      return res.status(400).json({
        success: false,
        message: 'No face reference found. Please complete activation first.',
        code: 'NO_FACE_REFERENCE'
      });
    }

    console.log('Face references found:', { total: faceRows.length });
    let referenceFaces;
    try {
      referenceFaces = extractReferenceFaces(faceRows);
    } catch (error) {
      console.error('Error parsing face_encoding:', error);
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(500).json({
        success: false,
        message: 'Invalid face reference data',
        code: 'INVALID_FACE_DATA'
      });
    }
    console.log('Reference faces parsed:', referenceFaces.length, 'faces');

    console.log('Step 4: Detecting faces across frames (multi-frame + TTA)...');
    // Multi-frame + test-time augmentation: gather probe faces from every uploaded frame,
    // tagging each with its source frame so the best one can be kept.
    let detectedFaces = [];
    for (const frame of frameFiles) {
      try {
        const pf = await getProbeFaces(frame.path, { tta: false });
        for (const f of pf) f._frame = frame;
        detectedFaces = detectedFaces.concat(pf);
      } catch (e) {
        console.warn('Frame detect failed:', e.message);
      }
    }
    console.log(`Detected ${detectedFaces.length} probe face(s) from ${frameFiles.length} frame(s)`);

    if (detectedFaces.length === 0) {
      // Simpan 1 frame sebagai bukti percobaan GAGAL (tak ada wajah), hapus sisanya
      await logFaceAttempt(connection, { idKaryawan: req.user.id, jenis: 'masuk', status: 'no_face', file: frameFiles[0] });
      for (let i = 1; i < frameFiles.length; i++) { const frame = frameFiles[i]; if (frame && fs.existsSync(frame.path)) { try { fs.unlinkSync(frame.path); } catch (e) {} } }
      return res.status(400).json({
        success: false,
        message: 'No faces detected in photo',
        code: 'NO_FACES_DETECTED'
      });
    }

    console.log('Step 5: Comparing faces...');
    const matchResults = await compareFaces(referenceFaces, detectedFaces);
    console.log('Match results:', matchResults.map(r => ({ isMatch: r.isMatch, similarity: Number(r.similarity).toFixed(3), variant: (r.face && r.face.variant) || 'orig' })));

    // Pick the closest matching probe across all frames/variants (minimum distance).
    const matching = matchResults.filter(r => r.isMatch).sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    const bestMatch = matching[0];

    // Keep only the chosen frame on disk; remove the others.
    const chosenFrame = (bestMatch && bestMatch.face && bestMatch.face._frame) ? bestMatch.face._frame : frameFiles[0];
    for (const frame of frameFiles) {
      if (frame !== chosenFrame && fs.existsSync(frame.path)) { try { fs.unlinkSync(frame.path); } catch (e) {} }
    }
    req.file = chosenFrame;

    if (!bestMatch) {
      const bestSim = Math.max(...matchResults.map(r => r.similarity));
      const bestDist = Math.min(...matchResults.map(r => (r.distance ?? Infinity)));
      // Simpan foto probe + catat percobaan GAGAL (wajah beda/orang lain) — tidak membuat presensi valid
      await logFaceAttempt(connection, { idKaryawan: req.user.id, jenis: 'masuk', status: 'no_match', similarity: bestSim, distance: Number.isFinite(bestDist) ? bestDist : null, file: req.file });

      return res.status(400).json({
        success: false,
        message: 'Face does not match reference',
        code: 'FACE_NO_MATCH',
        data: {
          similarity: bestSim,
          threshold: matchResults[0].threshold
        }
      });
    }

    console.log('Step 6: Checking if already checked in today...');
    // Check if already checked in today
    const today = getCurrentDateWITA();
    const bypassScheduleValidation = await isDevScheduleBypassEnabled();
    const [existingRows] = await connection.execute(
      'SELECT id FROM presensi WHERE id_karyawan = ? AND tanggal = ? AND jam_masuk IS NOT NULL',
      [req.user.id, today]
    );

    if (existingRows.length > 0) {
      if (bypassScheduleValidation) {
        // DEV MODE: allow repeating attendance on the same day.
        // Reset today's record so a fresh check-in -> break -> check-out cycle can start again.
        await connection.execute('DELETE FROM presensi WHERE id_karyawan = ? AND tanggal = ?', [req.user.id, today]);
        console.log('[DEV] Reset presensi for repeated check-in, employee', req.user.id);
      } else {
        if (fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
        return res.status(400).json({
          success: false,
          message: 'Already checked in today',
          code: 'ALREADY_CHECKED_IN'
        });
      }
    }

    console.log('Step 7: Getting work schedule...');
    // Get work schedule for status calculation
    const [scheduleRows] = await connection.execute(`
      SELECT
        ws.id,
        ws.nama AS nama,
        s.jam_masuk AS jam_masuk,
        s.jam_keluar AS jam_keluar,
        ws.hari_kerja AS hari_kerja,
        COALESCE(e.shift_id, ws.shift_id) AS active_shift_id
      FROM karyawan e
      LEFT JOIN jadwal_kerja ws ON e.id_jadwal_kerja = ws.id
      LEFT JOIN shift s ON s.id = COALESCE(e.shift_id, ws.shift_id)
      WHERE e.id = ?
      LIMIT 1
    `, [req.user.id]);

    let clockInStatus = 'on_time';
    let isLate = false;
    const currentTime = getCurrentTimeWITA(); // Use WITA timezone
    // bypassScheduleValidation already computed above (dev mode)

    if (scheduleRows.length > 0) {
      const schedule = scheduleRows[0];
      const workDays = parseWorkDays(schedule.hari_kerja);
      const todayName = getCurrentDayNameWITA().toLowerCase();
      const attendanceWindows = buildAttendanceWindows(schedule.jam_masuk, schedule.jam_keluar);
      
      // VALIDASI: Cek apakah hari ini adalah hari kerja
      const isWorkDay = workDays.some(day => day.toLowerCase() === todayName);
      
      if (!isWorkDay && !bypassScheduleValidation) {
        if (fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
        
        return res.status(400).json({
          success: false,
          message: `Hari ini (${todayName}) bukan hari kerja. Hari kerja: ${workDays.join(', ')}`,
          code: 'NOT_WORK_DAY',
          data: {
            today: todayName,
            workDays: workDays,
            scheduleName: schedule.nama
          }
        });
      }
      
      // Pengganti (disetujui) boleh clock-in lebih awal: ikut jam masuk shift orang yang
      // digantikan (tetap buffer 30 menit). Karyawan biasa tetap pakai window shift sendiri.
      let effectiveClockInStart = attendanceWindows.clock_in_start;
      try {
        // Pengganti diatur jauh hari (dibuat sebelum tanggal coveran) -> buffer 30 menit.
        // Pengganti diatur hari-H (tanggal pembuatan sama dengan hari ini) -> buffer 15 menit.
        // created_at tersimpan UTC, dikonversi ke WITA (+08:00) dulu agar banding tanggalnya akurat.
        const [coverRows] = await connection.execute(`
          SELECT
            s.jam_masuk AS jam_masuk,
            (DATE(CONVERT_TZ(pa.created_at, '+00:00', '+08:00')) < ?) AS is_advance
          FROM permintaan_absensi pa
          JOIN absensi ab ON ab.id = pa.id_absensi
          JOIN karyawan k ON k.id = ab.id_karyawan
          LEFT JOIN jadwal_kerja jk ON k.id_jadwal_kerja = jk.id
          LEFT JOIN shift s ON s.id = COALESCE(k.shift_id, jk.shift_id)
          WHERE pa.id_pengganti = ?
            AND pa.status = 'disetujui'
            AND ab.status = 'disetujui'
            AND ? BETWEEN ab.tanggal_mulai AND ab.tanggal_selesai
            AND s.jam_masuk IS NOT NULL
          ORDER BY s.jam_masuk ASC
          LIMIT 1
        `, [today, req.user.id, today]);
        if (coverRows.length > 0 && coverRows[0].jam_masuk) {
          // Jauh hari = 30 menit, hari-H = 15 menit sebelum jam masuk shift yang digantikan.
          const bufferMin = Number(coverRows[0].is_advance) === 1 ? 30 : 15;
          const coveredStart = addMinutesToTime(coverRows[0].jam_masuk, -bufferMin);
          // pakai window paling awal biar pengganti bisa nutupin dari awal shift yang digantikan
          if (effectiveClockInStart && coveredStart < effectiveClockInStart) {
            effectiveClockInStart = coveredStart;
          }
        }
      } catch (coverErr) {
        console.error('[clock-in] gagal cek jadwal pengganti:', coverErr.message);
      }

      // VALIDASI: Check-in hanya bisa dilakukan dalam window waktu yang ditentukan
      if (!bypassScheduleValidation && !isTimeInRange(currentTime, effectiveClockInStart, attendanceWindows.clock_in_end)) {
        if (fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }

        return res.status(400).json({
          success: false,
          message: `Check-in hanya bisa dilakukan antara jam ${effectiveClockInStart.substring(0,5)} - ${attendanceWindows.clock_in_end.substring(0,5)}`,
          code: 'OUTSIDE_CHECKIN_WINDOW',
          data: {
            currentTime: currentTime.substring(0,5),
            allowedStart: effectiveClockInStart.substring(0,5),
            allowedEnd: attendanceWindows.clock_in_end.substring(0,5),
            scheduleName: schedule.nama
          }
        });
      }
      
      // Tentukan status terlambat berdasarkan jam masuk kerja (start_time)
      const lateThreshold = addMinutesToTime(schedule.jam_masuk, 5);
      if (currentTime > lateThreshold) {
        clockInStatus = 'late';
        isLate = true;
      }
    }
    console.log('Clock in status:', clockInStatus, 'isLate:', isLate);

    console.log('Step 8: Saving attendance record...');
    // Save attendance record
    const approvedLeave = await getApprovedLeaveForDate(connection, req.user.id, today);
    const approvedLeaveMinutes = calculateLeaveMinutes(approvedLeave);
    const storedPhotoPath = await persistUploadedFile(req.file, { folder: 'uploads/karyawan' });
    const dataMasuk = buildPresensiEventData({
      photoPath: storedPhotoPath,
      latitude,
      longitude,
      distance: locationValidation.distance,
      similarity: bestMatch.similarity,
      deviceInfo: req.headers['user-agent']
    });

    const [attendanceResult] = await connection.execute(`
      INSERT INTO presensi
      (id_karyawan, tanggal, jam_masuk, status, keterangan, approved_leave_minutes, data_masuk)
      VALUES (?, ?, TIMESTAMP(?, ?), ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        jam_masuk = VALUES(jam_masuk),
        status = VALUES(status),
        keterangan = VALUES(keterangan),
        approved_leave_minutes = VALUES(approved_leave_minutes),
        data_masuk = VALUES(data_masuk)
    `, [
      req.user.id,
      today,
      today,
      currentTime,
      isLate ? 'late' : 'present',
      `checkin similarity=${bestMatch.similarity} distance=${locationValidation.distance}`,
      approvedLeaveMinutes,
      dataMasuk
    ]);
    console.log('Attendance saved, ID:', attendanceResult.insertId);
    console.log('=== CHECKIN REQUEST SUCCESS ===');

    res.json({
      success: true,
      message: 'Clock in successful',
      data: {
        attendanceId: attendanceResult.insertId,
        clockInTime: new Date().toISOString(),
        status: clockInStatus,
        location: {
          distance: locationValidation.distance,
          isValid: locationValidation.isValid
        },
        faceMatch: {
          isMatch: bestMatch.isMatch,
          similarity: bestMatch.similarity,
          confidence: bestMatch.confidence,
          facesDetected: detectedFaces.length
        }
      }
    });

  } catch (error) {
    console.error('=== CHECKIN REQUEST FAILED ===');
    console.error('Clock in error:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      sqlMessage: error.sqlMessage,
      sql: error.sql
    });
    
    // Delete uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'SERVER_ERROR',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    await connection.end();
  }
});

/**
 * @swagger
 * /api/attendance/break/start:
 *   post:
 *     tags: [Presensi]
 *     summary: Mulai istirahat karyawan
 *     description: Membuka sesi istirahat untuk presensi hari ini. Karyawan harus sudah clock in dan belum clock out.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Istirahat berhasil dimulai
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Istirahat dimulai
 *                 data:
 *                   $ref: '#/components/schemas/BreakInfo'
 *       400:
 *         description: Belum clock in atau sudah clock out
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               noCheckIn:
 *                 value:
 *                   success: false
 *                   message: Anda harus clock in terlebih dahulu sebelum mulai istirahat
 *                   code: NO_CHECK_IN
 *               alreadyCheckedOut:
 *                 value:
 *                   success: false
 *                   message: Istirahat tidak dapat dimulai setelah clock out
 *                   code: ALREADY_CHECKED_OUT
 *       409:
 *         description: Istirahat masih berlangsung
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: Istirahat masih berlangsung
 *                 code:
 *                   type: string
 *                   example: BREAK_ALREADY_STARTED
 *                 data:
 *                   $ref: '#/components/schemas/BreakInfo'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       500:
 *         $ref: '#/components/responses/ServerError'
 */
router.post('/attendance/break/start', authenticateToken, async (req, res) => {
  const connection = await getConnection();

  try {
    const today = getCurrentDateWITA();
    const startedAt = getCurrentDateTimeWITA();
    const breakAllowanceMinutes = await getBreakAllowanceMinutes(connection);

    const [attendanceRows] = await connection.execute(
      `SELECT id, data_masuk
       FROM presensi
       WHERE id_karyawan = ?
         AND tanggal = ?
         AND jam_masuk IS NOT NULL
       LIMIT 1`,
      [req.user.id, today]
    );

    if (!attendanceRows.length) {
      return res.status(400).json({
        success: false,
        message: 'Anda harus clock in terlebih dahulu sebelum mulai istirahat',
        code: 'NO_CHECK_IN'
      });
    }

    const [checkedOutRows] = await connection.execute(
      `SELECT id
       FROM presensi
       WHERE id_karyawan = ?
         AND tanggal = ?
         AND jam_keluar IS NOT NULL
       LIMIT 1`,
      [req.user.id, today]
    );

    if (checkedOutRows.length) {
      return res.status(400).json({
        success: false,
        message: 'Istirahat tidak dapat dimulai setelah clock out',
        code: 'ALREADY_CHECKED_OUT'
      });
    }

    const breakData = extractBreakFromDataMasuk(attendanceRows[0].data_masuk);
    if (getActiveBreakSessionIndex(breakData) >= 0) {
      return res.status(409).json({
        success: false,
        message: 'Istirahat masih berlangsung',
        code: 'BREAK_ALREADY_STARTED',
        data: buildBreakResponse(breakData, true, false, breakAllowanceMinutes)
      });
    }

    breakData.status = 'berlangsung';
    breakData.sesi.push({
      mulai: startedAt,
      selesai: null,
      durasi_menit: 0,
      lokasi_selesai: null
    });
    breakData.total_menit = recalculateBreakTotalMinutes(breakData);

    await connection.execute(
      `UPDATE presensi
       SET data_masuk = ?
       WHERE id = ?`,
      [mergeBreakIntoDataMasuk(attendanceRows[0].data_masuk, breakData), attendanceRows[0].id]
    );

    return res.json({
      success: true,
      message: 'Istirahat dimulai',
      data: buildBreakResponse(breakData, true, false, breakAllowanceMinutes)
    });
  } catch (error) {
    console.error('Start break error:', error);
    return res.status(500).json({
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
 * /api/attendance/break/end:
 *   post:
 *     tags: [Presensi]
 *     summary: Selesai istirahat karyawan (verifikasi wajah + lokasi)
 *     description: Menutup sesi istirahat aktif. Foto wajah dan lokasi wajib dikirim; wajah harus cocok dengan referensi dan lokasi harus berada dalam radius kantor.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - photo
 *               - latitude
 *               - longitude
 *             properties:
 *               photo:
 *                 type: string
 *                 format: binary
 *                 description: Foto untuk verifikasi wajah (boleh beberapa frame)
 *               latitude:
 *                 type: number
 *                 example: -8.3974062
 *               longitude:
 *                 type: number
 *                 example: 115.54240086
 *     responses:
 *       200:
 *         description: Istirahat berhasil diselesaikan
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Istirahat selesai
 *                 data:
 *                   $ref: '#/components/schemas/BreakInfo'
 *       400:
 *         description: Validasi gagal
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: Anda belum berada di area kantor
 *                 code:
 *                   type: string
 *                   example: BREAK_LOCATION_INVALID
 *                 data:
 *                   type: object
 *                   properties:
 *                     distance:
 *                       type: number
 *                       example: 1200
 *                     allowedRadius:
 *                       type: number
 *                       example: 300
 *                     break:
 *                       $ref: '#/components/schemas/BreakInfo'
 *             examples:
 *               noLocation:
 *                 value:
 *                   success: false
 *                   message: Lokasi wajib dikirim untuk menyelesaikan istirahat
 *                   code: NO_LOCATION
 *               noActiveBreak:
 *                 value:
 *                   success: false
 *                   message: Tidak ada istirahat yang sedang berlangsung
 *                   code: NO_ACTIVE_BREAK
 *               invalidLocation:
 *                 value:
 *                   success: false
 *                   message: Anda belum berada di area kantor
 *                   code: BREAK_LOCATION_INVALID
 *                   data:
 *                     distance: 1200
 *                     allowedRadius: 300
 *               noPhoto:
 *                 value:
 *                   success: false
 *                   message: Foto wajib dikirim untuk menyelesaikan istirahat
 *                   code: NO_PHOTO
 *               faceNotMatched:
 *                 value:
 *                   success: false
 *                   message: Verifikasi wajah gagal. Pastikan wajah Anda terlihat jelas.
 *                   code: FACE_NOT_MATCHED
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       500:
 *         $ref: '#/components/responses/ServerError'
 */
router.post('/attendance/break/end', authenticateToken, upload.array('photo', 5), async (req, res) => {
  const connection = await getConnection();
  let keepFilePath = null; // frame yang disimpan sebagai bukti percobaan gagal — jangan dihapus di finally

  try {
    // Multi-frame: collect all uploaded frames; req.file becomes the first frame downstream.
    const frameFiles = Array.isArray(req.files) && req.files.length ? req.files : (req.file ? [req.file] : []);
    req.file = frameFiles[0] || null;

    const { latitude, longitude } = req.body;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Foto wajib dikirim untuk menyelesaikan istirahat',
        code: 'NO_PHOTO'
      });
    }

    if (latitude === undefined || longitude === undefined || latitude === '' || longitude === '') {
      return res.status(400).json({
        success: false,
        message: 'Lokasi wajib dikirim untuk menyelesaikan istirahat',
        code: 'NO_LOCATION'
      });
    }

    const today = getCurrentDateWITA();
    const finishedAt = getCurrentDateTimeWITA();
    const breakAllowanceMinutes = await getBreakAllowanceMinutes(connection);

    const [attendanceRows] = await connection.execute(
      `SELECT id, data_masuk
       FROM presensi
       WHERE id_karyawan = ?
         AND tanggal = ?
         AND jam_masuk IS NOT NULL
       LIMIT 1`,
      [req.user.id, today]
    );

    if (!attendanceRows.length) {
      return res.status(400).json({
        success: false,
        message: 'Anda harus clock in terlebih dahulu sebelum menyelesaikan istirahat',
        code: 'NO_CHECK_IN'
      });
    }

    const [checkedOutRows] = await connection.execute(
      `SELECT id
       FROM presensi
       WHERE id_karyawan = ?
         AND tanggal = ?
         AND jam_keluar IS NOT NULL
       LIMIT 1`,
      [req.user.id, today]
    );

    if (checkedOutRows.length) {
      return res.status(400).json({
        success: false,
        message: 'Istirahat tidak dapat diselesaikan setelah clock out',
        code: 'ALREADY_CHECKED_OUT'
      });
    }

    const breakData = extractBreakFromDataMasuk(attendanceRows[0].data_masuk);
    if (getActiveBreakSessionIndex(breakData) < 0) {
      return res.status(400).json({
        success: false,
        message: 'Tidak ada istirahat yang sedang berlangsung',
        code: 'NO_ACTIVE_BREAK',
        data: buildBreakResponse(breakData, true, false, breakAllowanceMinutes)
      });
    }

    const [settingsRows] = await connection.execute(
      `SELECT
        lat_kantor AS lat_kantor,
        long_kantor AS long_kantor,
        radius_meter
       FROM pengaturan
       LIMIT 1`
    );

    if (!settingsRows.length) {
      return res.status(500).json({
        success: false,
        message: 'Office location not configured',
        code: 'NO_OFFICE_LOCATION'
      });
    }

    const settings = settingsRows[0];
    const locationValidation = isLocationValid(
      parseFloat(latitude),
      parseFloat(longitude),
      parseFloat(settings.lat_kantor),
      parseFloat(settings.long_kantor),
      settings.radius_meter
    );

    if (!locationValidation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Anda belum berada di area kantor',
        code: 'BREAK_LOCATION_INVALID',
        data: {
          distance: locationValidation.distance,
          allowedRadius: locationValidation.allowedRadius,
          break: buildBreakResponse(breakData, true, false, breakAllowanceMinutes)
        }
      });
    }

    // Verifikasi wajah (sama seperti clock in/out) — flowchart: "Verifikasi Wajah + Lokasi" saat selesai istirahat.
    const [faceRows] = await connection.execute(
      `SELECT id, id_karyawan AS id_karyawan, face_encoding, photo_path, is_active, enrollment_method, created_at, updated_at
       FROM karyawan_face_reference
       WHERE id_karyawan = ? AND is_active = TRUE`,
      [req.user.id]
    );

    if (faceRows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Data wajah belum terdaftar. Silakan daftarkan wajah terlebih dahulu.',
        code: 'NO_FACE_REFERENCE'
      });
    }

    let referenceFaces;
    try {
      referenceFaces = extractReferenceFaces(faceRows);
    } catch (error) {
      console.error('Error parsing face_encoding:', error);
      return res.status(500).json({
        success: false,
        message: 'Invalid face reference data',
        code: 'INVALID_FACE_DATA'
      });
    }

    // Multi-frame + TTA: gather probe faces from every uploaded frame.
    let detectedFaces = [];
    for (const frame of frameFiles) {
      try {
        const pf = await getProbeFaces(frame.path, { tta: false });
        for (const f of pf) f._frame = frame;
        detectedFaces = detectedFaces.concat(pf);
      } catch (e) {
        console.warn('Frame detect failed:', e.message);
      }
    }

    if (detectedFaces.length === 0) {
      keepFilePath = frameFiles[0] && frameFiles[0].path ? frameFiles[0].path : null;
      await logFaceAttempt(connection, { idKaryawan: req.user.id, jenis: 'istirahat', status: 'no_face', file: frameFiles[0] });
      return res.status(400).json({
        success: false,
        message: 'Wajah tidak terdeteksi pada foto',
        code: 'NO_FACES_DETECTED'
      });
    }

    const matchResults = await compareFaces(referenceFaces, detectedFaces);
    const matching = matchResults.filter(r => r.isMatch).sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    if (!matching.length) {
      const bestSim = Math.max(...matchResults.map(r => r.similarity));
      const bestDist = Math.min(...matchResults.map(r => (r.distance ?? Infinity)));
      keepFilePath = frameFiles[0] && frameFiles[0].path ? frameFiles[0].path : null;
      await logFaceAttempt(connection, { idKaryawan: req.user.id, jenis: 'istirahat', status: 'no_match', similarity: bestSim, distance: Number.isFinite(bestDist) ? bestDist : null, file: frameFiles[0] });
      return res.status(400).json({
        success: false,
        message: 'Verifikasi wajah gagal. Pastikan wajah Anda terlihat jelas.',
        code: 'FACE_NOT_MATCHED'
      });
    }

    // Simpan foto probe istirahat yang COCOK (bahan data pengujian /admin/testing) — istirahat ikut ter-track.
    const bestBreak = matching[0];
    const breakFrame = (bestBreak.face && bestBreak.face._frame) ? bestBreak.face._frame : frameFiles[0];
    let breakFotoPath = null;
    try {
      breakFotoPath = await persistUploadedFile(breakFrame, { folder: 'uploads/karyawan' });
      keepFilePath = breakFrame.path; // jangan dihapus di finally
    } catch (e) {
      console.warn('[break] simpan foto gagal:', e.message);
    }

    const closeResult = closeActiveBreakSession(breakData, finishedAt, {
      lokasi_selesai: {
        latitude: Number(latitude),
        longitude: Number(longitude),
        jarak_meter: Number(locationValidation.distance),
        valid: true
      },
      foto: breakFotoPath,
      face_similarity: bestBreak.similarity
    });

    await connection.execute(
      `UPDATE presensi
       SET data_masuk = ?
       WHERE id = ?`,
      [mergeBreakIntoDataMasuk(attendanceRows[0].data_masuk, closeResult.breakData), attendanceRows[0].id]
    );

    return res.json({
      success: true,
      message: 'Istirahat selesai',
      data: buildBreakResponse(closeResult.breakData, true, false, breakAllowanceMinutes)
    });
  } catch (error) {
    console.error('End break error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'SERVER_ERROR'
    });
  } finally {
    // Foto verifikasi istirahat tidak disimpan — hapus semua frame yang diupload,
    // KECUALI frame yang sengaja disimpan sebagai bukti percobaan gagal (keepFilePath).
    const files = Array.isArray(req.files) ? req.files : (req.file ? [req.file] : []);
    for (const f of files) {
      if (f && f.path && f.path !== keepFilePath && fs.existsSync(f.path)) {
        try { fs.unlinkSync(f.path); } catch (e) {}
      }
    }
    await connection.end();
  }
});
/**
 * @swagger
 * /api/attendance/checkout:
 *   post:
 *     tags: [Presensi]
 *     summary: Clock out dengan foto dan lokasi
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - photo
 *               - latitude
 *               - longitude
 *             properties:
 *               photo:
 *                 type: string
 *                 format: binary
 *                 description: Foto untuk face recognition
 *               latitude:
 *                 type: number
 *                 description: Latitude lokasi
 *               longitude:
 *                 type: number
 *                 description: Longitude lokasi
 *     responses:
 *       200:
 *         description: Clock out berhasil
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Clock out successful"
 *                 data:
 *                   type: object
 *                   properties:
 *                     attendanceId:
 *                       type: integer
 *                     clockOutTime:
 *                       type: string
 *                     status:
 *                       type: string
 *                       example: "on_time"
 *                     workDuration:
 *                       type: string
 *                       example: "8 hours 30 minutes"
 */
router.post('/attendance/checkout', authenticateToken, upload.array('photo', 5), async (req, res) => {
  const connection = await getConnection();

  try {
    // Multi-frame: collect all uploaded frames; req.file becomes the chosen (best) frame downstream.
    const frameFiles = Array.isArray(req.files) && req.files.length ? req.files : (req.file ? [req.file] : []);
    req.file = frameFiles[0] || null;

    const { latitude, longitude } = req.body;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Photo is required',
        code: 'NO_PHOTO'
      });
    }

    if (!latitude || !longitude) {
      return res.status(400).json({
        success: false,
        message: 'Location coordinates are required',
        code: 'NO_LOCATION'
      });
    }

    // Check if already checked out today
    const today = getCurrentDateWITA();
    const bypassScheduleValidation = await isDevScheduleBypassEnabled();
    const [existingCheckOut] = await connection.execute(
      'SELECT id FROM presensi WHERE id_karyawan = ? AND tanggal = ? AND jam_keluar IS NOT NULL',
      [req.user.id, today]
    );

    // DEV MODE: allow checking out again on the same day (overwrite previous check-out)
    if (existingCheckOut.length > 0 && !bypassScheduleValidation) {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }

      return res.status(400).json({
        success: false,
        message: 'Already checked out today',
        code: 'ALREADY_CHECKED_OUT'
      });
    }

    // Check if checked in today
    const [checkInRows] = await connection.execute(
      `SELECT *, TIME(jam_masuk) AS jam_masuk
       FROM presensi
       WHERE id_karyawan = ? AND tanggal = ? AND jam_masuk IS NOT NULL
       LIMIT 1`,
      [req.user.id, today]
    );

    if (checkInRows.length === 0) {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      
      return res.status(400).json({
        success: false,
        message: 'Must check in first before checking out',
        code: 'NO_CHECK_IN'
      });
    }

    // Validate location (same as check in)
    const [settingsRows] = await connection.execute(
      `SELECT
        lat_kantor AS lat_kantor,
        long_kantor AS long_kantor,
        radius_meter,
        durasi_istirahat_menit
      FROM pengaturan
      LIMIT 1`
    );

    const settings = settingsRows[0];
    const breakAllowanceMinutes = settings.durasi_istirahat_menit || DEFAULT_BREAK_ALLOWANCE_MINUTES;
    const locationValidation = isLocationValid(
      parseFloat(latitude),
      parseFloat(longitude),
      parseFloat(settings.lat_kantor),
      parseFloat(settings.long_kantor),
      settings.radius_meter
    );

    if (!locationValidation.isValid) {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      
      return res.status(400).json({
        success: false,
        message: 'Location is outside allowed area',
        code: 'LOCATION_INVALID',
        data: {
          distance: locationValidation.distance,
          allowedRadius: locationValidation.allowedRadius
        }
      });
    }

    // Face recognition validation (same as check in)
    const [faceRows] = await connection.execute(
      `SELECT
        id,
        id_karyawan AS id_karyawan,
        face_encoding,
        photo_path,
        is_active,
        enrollment_method,
        created_at,
        updated_at
      FROM karyawan_face_reference
      WHERE id_karyawan = ? AND is_active = TRUE`,
      [req.user.id]
    );

    if (faceRows.length === 0) {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      
      return res.status(400).json({
        success: false,
        message: 'Face reference not found. Please register your face first.',
        code: 'NO_FACE_REFERENCE'
      });
    }

    // Parse face encoding from all active references
    let referenceFaces;
    try {
      referenceFaces = extractReferenceFaces(faceRows);
    } catch (error) {
      console.error('Error parsing face_encoding:', error);
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(500).json({
        success: false,
        message: 'Invalid face reference data',
        code: 'INVALID_FACE_DATA'
      });
    }
    
    // Multi-frame + TTA: gather probe faces from every uploaded frame.
    let detectedFaces = [];
    for (const frame of frameFiles) {
      try {
        const pf = await getProbeFaces(frame.path, { tta: false });
        for (const f of pf) f._frame = frame;
        detectedFaces = detectedFaces.concat(pf);
      } catch (e) {
        console.warn('Frame detect failed:', e.message);
      }
    }

    if (detectedFaces.length === 0) {
      // Simpan 1 frame sebagai bukti percobaan GAGAL (tak ada wajah), hapus sisanya
      await logFaceAttempt(connection, { idKaryawan: req.user.id, jenis: 'keluar', status: 'no_face', file: frameFiles[0] });
      for (let i = 1; i < frameFiles.length; i++) { const frame = frameFiles[i]; if (frame && fs.existsSync(frame.path)) { try { fs.unlinkSync(frame.path); } catch (e) {} } }
      return res.status(400).json({
        success: false,
        message: 'No faces detected in photo',
        code: 'NO_FACES_DETECTED'
      });
    }

    const matchResults = await compareFaces(referenceFaces, detectedFaces);
    const matching = matchResults.filter(r => r.isMatch).sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    const bestMatch = matching[0];

    // Keep only the chosen frame on disk; remove the others.
    const chosenFrame = (bestMatch && bestMatch.face && bestMatch.face._frame) ? bestMatch.face._frame : frameFiles[0];
    for (const frame of frameFiles) {
      if (frame !== chosenFrame && fs.existsSync(frame.path)) { try { fs.unlinkSync(frame.path); } catch (e) {} }
    }
    req.file = chosenFrame;

    if (!bestMatch) {
      const bestSim = Math.max(...matchResults.map(r => r.similarity));
      const bestDist = Math.min(...matchResults.map(r => (r.distance ?? Infinity)));
      // Simpan foto probe + catat percobaan GAGAL (wajah beda/orang lain) — tidak membuat presensi valid
      await logFaceAttempt(connection, { idKaryawan: req.user.id, jenis: 'keluar', status: 'no_match', similarity: bestSim, distance: Number.isFinite(bestDist) ? bestDist : null, file: req.file });

      return res.status(400).json({
        success: false,
        message: 'Face does not match reference',
        code: 'FACE_NO_MATCH'
      });
    }

    // Calculate work duration
    const checkInRow = checkInRows[0];
    // Get current time in WITA (UTC+8)
    const now = new Date();
    const witaOffset = 8 * 60; // WITA is UTC+8
    const localOffset = now.getTimezoneOffset();
    const witaTime = new Date(now.getTime() + (witaOffset + localOffset) * 60 * 1000);
    
    // Combine tanggal and jam_masuk to create a proper datetime in WITA
    const checkInDate = new Date(checkInRow.tanggal);
    const [jamMasukHour, jamMasukMin, jamMasukSec] = String(checkInRow.jam_masuk).split(':').map(Number);
    const checkInTime = new Date(checkInDate.getFullYear(), checkInDate.getMonth(), checkInDate.getDate(), jamMasukHour, jamMasukMin, jamMasukSec || 0);
    
    const checkOutTime = new Date(witaTime.getFullYear(), witaTime.getMonth(), witaTime.getDate(), witaTime.getHours(), witaTime.getMinutes(), witaTime.getSeconds());
    
    const workDurationMs = checkOutTime - checkInTime;
    const workDurationMinutes = Math.floor(workDurationMs / (1000 * 60));
    const hours = Math.floor(workDurationMinutes / 60);
    const minutes = workDurationMinutes % 60;
    const approvedLeave = await getApprovedLeaveForDate(connection, req.user.id, today);
    const approvedLeaveMinutes = calculateLeaveMinutes(approvedLeave);

    // Get work schedule for status calculation
    const [scheduleRows] = await connection.execute(`
      SELECT
        ws.id,
        ws.nama AS nama,
        s.jam_masuk AS jam_masuk,
        s.jam_keluar AS jam_keluar,
        ws.hari_kerja AS hari_kerja,
        COALESCE(e.shift_id, ws.shift_id) AS active_shift_id
      FROM karyawan e
      LEFT JOIN jadwal_kerja ws ON e.id_jadwal_kerja = ws.id
      LEFT JOIN shift s ON s.id = COALESCE(e.shift_id, ws.shift_id)
      WHERE e.id = ?
      LIMIT 1
    `, [req.user.id]);

    let clockOutStatus = 'on_time';
    const currentTime = getCurrentTimeWITA(); // Use WITA timezone
    let schedule = null;
    // bypassScheduleValidation already computed above (dev mode)

    if (scheduleRows.length > 0) {
      schedule = scheduleRows[0];
      const workDays = parseWorkDays(schedule.hari_kerja);
      const todayName = getCurrentDayNameWITA().toLowerCase();
      const attendanceWindows = buildAttendanceWindows(schedule.jam_masuk, schedule.jam_keluar);
      
      // VALIDASI: Cek apakah hari ini adalah hari kerja
      const isWorkDay = workDays.some(day => day.toLowerCase() === todayName);
      
      if (!isWorkDay && !bypassScheduleValidation) {
        if (fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
        
        return res.status(400).json({
          success: false,
          message: `Hari ini (${todayName}) bukan hari kerja. Hari kerja: ${workDays.join(', ')}`,
          code: 'NOT_WORK_DAY',
          data: {
            today: todayName,
            workDays: workDays,
            scheduleName: schedule.nama
          }
        });
      }
      
      // VALIDASI: Check-out hanya bisa dilakukan dalam window waktu yang ditentukan
      if (!bypassScheduleValidation && !isTimeInRange(currentTime, attendanceWindows.clock_out_start, attendanceWindows.clock_out_end)) {
        if (fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
        
        return res.status(400).json({
          success: false,
          message: `Check-out hanya bisa dilakukan antara jam ${attendanceWindows.clock_out_start.substring(0,5)} - ${attendanceWindows.clock_out_end.substring(0,5)}`,
          code: 'OUTSIDE_CHECKOUT_WINDOW',
          data: {
            currentTime: currentTime.substring(0,5),
            allowedStart: attendanceWindows.clock_out_start.substring(0,5),
            allowedEnd: attendanceWindows.clock_out_end.substring(0,5),
            scheduleName: schedule.nama
          }
        });
      }
      
      // Tentukan status checkout berdasarkan jam pulang kerja (end_time)
      if (currentTime < schedule.jam_keluar) {
        clockOutStatus = 'early';
      } else if (currentTime > schedule.jam_keluar) {
        clockOutStatus = 'overtime';
      }
    }

    const breakData = extractBreakFromDataMasuk(checkInRow.data_masuk);
    const autoCloseResult = closeActiveBreakSession(breakData, `${today} ${currentTime}`, {
      lokasi_selesai: null,
      auto_closed: true,
      auto_closed_reason: 'clock_out'
    });
    const finalBreakData = autoCloseResult.breakData;
    const actualBreakMinutes = Number(finalBreakData.total_menit || 0);
    const countedBreakMinutes = calculateCountedBreakMinutes(finalBreakData, breakAllowanceMinutes);
    finalBreakData.durasi_istirahat_menit = breakAllowanceMinutes;
    finalBreakData.dihitung_menit = countedBreakMinutes;

    const summary = calculateWorkSummary({
      schedule,
      checkInTime: String(checkInRow.jam_masuk),
      checkOutTime: currentTime,
      leaveMinutes: approvedLeaveMinutes,
      breakMinutes: countedBreakMinutes
    });
    const storedPhotoPath = await persistUploadedFile(req.file, { folder: 'uploads/karyawan' });
    const dataKeluar = buildPresensiEventData({
      photoPath: storedPhotoPath,
      latitude,
      longitude,
      distance: locationValidation.distance,
      similarity: bestMatch.similarity,
      deviceInfo: req.headers['user-agent']
    });

    // Save attendance record
    await connection.execute(`
      UPDATE presensi
      SET jam_keluar = TIMESTAMP(?, ?),
          keterangan = ?,
          approved_leave_minutes = ?,
          total_work_minutes = ?,
          effective_work_minutes = ?,
          overtime_minutes = ?,
          late_minutes = ?,
          early_leave_minutes = ?,
          data_masuk = ?,
          data_keluar = ?
      WHERE id_karyawan = ? AND tanggal = ? AND jam_keluar IS NULL
    `, [
      today,
      currentTime,
      `checkout similarity=${bestMatch.similarity} distance=${locationValidation.distance}; Durasi kerja: ${hours} jam ${minutes} menit`,
      approvedLeaveMinutes,
      workDurationMinutes,
      summary.effectiveWorkMinutes,
      summary.overtimeMinutes,
      summary.lateMinutes,
      summary.earlyLeaveMinutes,
      mergeBreakIntoDataMasuk(checkInRow.data_masuk, finalBreakData),
      dataKeluar,
      req.user.id,
      today
    ]);

    res.json({
      success: true,
      message: 'Clock out successful',
      data: {
        attendanceId: checkInRow.id,
        clockOutTime: checkOutTime.toISOString(),
        status: clockOutStatus,
        workDuration: `${hours} hours ${minutes} minutes`,
        workDurationMinutes: workDurationMinutes,
        overtimeMinutes: summary.overtimeMinutes,
        approvedLeaveMinutes: approvedLeaveMinutes,
        breakMinutes: countedBreakMinutes,
        actualBreakMinutes: actualBreakMinutes,
        effectiveWorkMinutes: summary.effectiveWorkMinutes,
        break: buildBreakResponse(finalBreakData, true, true, breakAllowanceMinutes),
        location: {
          distance: locationValidation.distance,
          isValid: locationValidation.isValid
        },
        faceMatch: {
          isMatch: bestMatch.isMatch,
          similarity: bestMatch.similarity,
          confidence: bestMatch.confidence,
          facesDetected: detectedFaces.length
        }
      }
    });

  } catch (error) {
    console.error('Clock out error:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      sqlMessage: error.sqlMessage,
      sql: error.sql
    });
    
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'SERVER_ERROR',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    await connection.end();
  }
});

/**
 * @swagger
 * /api/attendance/status/{id_karyawan}:
 *   get:
 *     tags: [Attendance]
 *     summary: Get status presensi hari ini
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id_karyawan
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID karyawan
 *     responses:
 *       200:
 *         description: Status presensi hari ini
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     date:
 *                       type: string
 *                       example: "2024-01-15"
 *                     hasCheckedIn:
 *                       type: boolean
 *                     hasCheckedOut:
 *                       type: boolean
 *                     checkIn:
 *                       type: object
 *                       properties:
 *                         time:
 *                           type: string
 *                         status:
 *                           type: string
 *                         similarity:
 *                           type: number
 *                     checkOut:
 *                       type: object
 *                       properties:
 *                         time:
 *                           type: string
 *                         status:
 *                           type: string
 *                         workDuration:
 *                           type: string
 *                     canCheckIn:
 *                       type: boolean
 *                     canCheckOut:
 *                       type: boolean
 */
router.get('/attendance/status/:id_karyawan', authenticateToken, async (req, res) => {
  const connection = await getConnection();
  
  try {
    const { id_karyawan } = req.params;

    // Verify user can only access their own status
    if (parseInt(id_karyawan) !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied',
        code: 'ACCESS_DENIED'
      });
    }

    const today = getCurrentDateWITA();

    // Get today's attendance records
    const [attendanceRows] = await connection.execute(`
      SELECT
        ad.*,
        TIME(ad.jam_masuk) AS jam_masuk,
        TIME(ad.jam_keluar) AS jam_keluar
      FROM presensi ad
      WHERE ad.id_karyawan = ? AND ad.tanggal = ?
      ORDER BY ad.created_at ASC
    `, [id_karyawan, today]);

    const checkInRecord = attendanceRows.find(r => r.jam_masuk !== null) || null;
    const checkOutRecord = attendanceRows.find(r => r.jam_keluar !== null) || null;
    const checkInData = parseJsonColumn(checkInRecord?.data_masuk);
    const checkOutData = parseJsonColumn(checkOutRecord?.data_keluar);
    const breakData = extractBreakFromDataMasuk(checkInRecord?.data_masuk || checkOutRecord?.data_masuk);
    const breakAllowanceMinutes = await getBreakAllowanceMinutes(connection);

    // Helper function to format date properly
    const formatDate = (dateValue) => {
      if (!dateValue) return null;
      try {
        // If it's already a Date object, convert to ISO string
        if (dateValue instanceof Date) {
          return dateValue.toISOString().split('T')[0];
        }
        // If it's a string, try to parse it
        const date = new Date(dateValue);
        return date.toISOString().split('T')[0];
      } catch (e) {
        console.error('Error formatting date:', e);
        return null;
      }
    };

    // Calculate work duration
    let workDuration = null;
    let workDurationMinutes = null;
    
    if (checkInRecord && checkOutRecord) {
      // Both clock in and clock out exist - calculate duration
      const checkInDate = new Date(checkInRecord.tanggal);
      const [jamMasukHour, jamMasukMin, jamMasukSec] = checkInRecord.jam_masuk.split(':').map(Number);
      const checkInDateTime = new Date(checkInDate.getFullYear(), checkInDate.getMonth(), checkInDate.getDate(), jamMasukHour, jamMasukMin, jamMasukSec || 0);
      
      const checkOutDate = new Date(checkOutRecord.tanggal);
      const [jamKeluarHour, jamKeluarMin, jamKeluarSec] = checkOutRecord.jam_keluar.split(':').map(Number);
      const checkOutDateTime = new Date(checkOutDate.getFullYear(), checkOutDate.getMonth(), checkOutDate.getDate(), jamKeluarHour, jamKeluarMin, jamKeluarSec || 0);
      
      workDurationMinutes = Math.floor((checkOutDateTime - checkInDateTime) / (1000 * 60));
      
      const hours = Math.floor(workDurationMinutes / 60);
      const minutes = workDurationMinutes % 60;
      workDuration = `${hours} jam ${minutes} menit`;
    }
    // Don't calculate duration if only checked in (wait until check out)

    // Get work schedule to determine if can check in/out
    const [scheduleRows] = await connection.execute(`
      SELECT
        ws.id,
        ws.nama AS nama,
        s.jam_masuk AS jam_masuk,
        s.jam_keluar AS jam_keluar,
        ws.hari_kerja AS hari_kerja
      FROM karyawan e
      LEFT JOIN jadwal_kerja ws ON e.id_jadwal_kerja = ws.id
      LEFT JOIN shift s ON s.id = COALESCE(e.shift_id, ws.shift_id)
      WHERE e.id = ?
      LIMIT 1
    `, [id_karyawan]);

    let canCheckIn = !checkInRecord;
    let canCheckOut = checkInRecord && !checkOutRecord;
    const bypassScheduleValidation = await isDevScheduleBypassEnabled(connection);

    if (scheduleRows.length > 0) {
      const schedule = scheduleRows[0];
      const currentTime = getCurrentTimeWITA();
      const workDays = parseWorkDays(schedule.hari_kerja);
      const todayName = getCurrentDayNameWITA();
      const attendanceWindows = buildAttendanceWindows(schedule.jam_masuk, schedule.jam_keluar);
      
      // Debug logging
      console.log('[DEBUG] Attendance Status Check:');
      console.log('  - Current Time:', currentTime);
      console.log('  - Today:', todayName);
      console.log('  - Work Days:', workDays);
      console.log('  - Schedule:', {
        nama: schedule.nama,
        clock_in_start: attendanceWindows.clock_in_start,
        clock_in_end: attendanceWindows.clock_in_end,
        clock_out_start: attendanceWindows.clock_out_start,
        clock_out_end: attendanceWindows.clock_out_end
      });
      console.log('  - Has Checked In:', !!checkInRecord);
      console.log('  - Has Checked Out:', !!checkOutRecord);
      
      // Check if today is a work day (case-insensitive)
      const isWorkDay = workDays.some(day => day.toLowerCase() === todayName.toLowerCase());
      console.log('  - Is Work Day:', isWorkDay);
      
      if (!isWorkDay && !bypassScheduleValidation) {
        canCheckIn = false;
        canCheckOut = false;
        console.log('  - Result: NOT A WORK DAY - buttons disabled');
      } else {
        // Check time constraints
        if (!bypassScheduleValidation && canCheckIn && attendanceWindows.clock_in_start && attendanceWindows.clock_in_end) {
          const timeCheckIn = isTimeInRange(currentTime, attendanceWindows.clock_in_start, attendanceWindows.clock_in_end);
          console.log('  - Clock In Time Check:', {
            current: currentTime,
            start: attendanceWindows.clock_in_start,
            end: attendanceWindows.clock_in_end,
            valid: timeCheckIn
          });
          canCheckIn = timeCheckIn;
        } else {
          console.log('  - Clock In: No time constraints or already checked in');
        }
        
        if (!bypassScheduleValidation && canCheckOut && attendanceWindows.clock_out_start && attendanceWindows.clock_out_end) {
          const timeCheckOut = isTimeInRange(currentTime, attendanceWindows.clock_out_start, attendanceWindows.clock_out_end);
          console.log('  - Clock Out Time Check:', {
            current: currentTime,
            start: attendanceWindows.clock_out_start,
            end: attendanceWindows.clock_out_end,
            valid: timeCheckOut
          });
          canCheckOut = timeCheckOut;
        } else {
          console.log('  - Clock Out: No time constraints or not ready');
        }
      }
      
      console.log('  - Final Result: canCheckIn =', canCheckIn, ', canCheckOut =', canCheckOut);
    } else {
      console.log('[DEBUG] No work schedule found for employee', id_karyawan);
    }

    // DEV MODE: after a completed cycle (checked in AND out), present today as fresh so the
    // mobile app shows Clock In again and the full attendance flow can be repeated on the same day.
    const devFresh = bypassScheduleValidation && !!checkInRecord && !!checkOutRecord;

    const response = {
      success: true,
      message: 'Attendance status retrieved successfully',
      data: {
        date: today,
        hasCheckedIn: devFresh ? false : !!checkInRecord,
        hasCheckedOut: devFresh ? false : !!checkOutRecord,
        checkIn: (!devFresh && checkInRecord) ? {
          time: `${formatDate(checkInRecord.tanggal)}T${checkInRecord.jam_masuk}`,
          latitude: checkInData.latitude ?? null,
          longitude: checkInData.longitude ?? null,
          distance: checkInData.jarak_meter ?? null,
          similarity: checkInData.face_similarity ?? null,
          photo: checkInData.foto ?? null
        } : null,
        checkOut: (!devFresh && checkOutRecord) ? {
          time: `${formatDate(checkOutRecord.tanggal)}T${checkOutRecord.jam_keluar}`,
          latitude: checkOutData.latitude ?? null,
          longitude: checkOutData.longitude ?? null,
          distance: checkOutData.jarak_meter ?? null,
          similarity: checkOutData.face_similarity ?? null,
          photo: checkOutData.foto ?? null
        } : null,
        workDuration: devFresh ? null : workDuration,
        break: devFresh
          ? buildBreakResponse(normalizeBreakData(null), false, false, breakAllowanceMinutes)
          : buildBreakResponse(breakData, !!checkInRecord, !!checkOutRecord, breakAllowanceMinutes),
        canCheckIn: devFresh ? true : canCheckIn,
        canCheckOut: devFresh ? false : canCheckOut,
        nextAction: devFresh ? 'clock_in' : (!checkInRecord ? 'clock_in' : (!checkOutRecord ? 'clock_out' : 'completed')),
        workSchedule: (() => {
          const ALL_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
          if (scheduleRows.length > 0) {
            const sc = scheduleRows[0];
            return {
              nama: sc.nama,
              jam_masuk: sc.jam_masuk,
              jam_keluar: sc.jam_keluar,
              ...buildAttendanceWindows(sc.jam_masuk, sc.jam_keluar),
              // DEV bypass: treat every day as a work day so testing isn't blocked by jadwal
              hari_kerja: bypassScheduleValidation ? ALL_DAYS : parseWorkDays(sc.hari_kerja)
            };
          }
          // No schedule assigned: in dev bypass, return a synthetic always-valid schedule
          // so the mobile app still shows the clock-in button (no jadwal setup needed for testing)
          return bypassScheduleValidation ? {
            nama: 'Dev Mode (semua hari)',
            jam_masuk: null,
            jam_keluar: null,
            ...buildAttendanceWindows(null, null),
            hari_kerja: ALL_DAYS
          } : null;
        })()
      }
    };

    // Debug logging for work schedule
    if (scheduleRows.length > 0) {
      console.log('[Attendance Status] Work Schedule for employee', id_karyawan);
      console.log('  - Raw hari_kerja:', scheduleRows[0].hari_kerja);
      console.log('  - Parsed hari_kerja:', response.data.workSchedule.hari_kerja);
    }

    res.json(response);

  } catch (error) {
    console.error('Get attendance status error:', error);
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
 * /api/attendance/today:
 *   get:
 *     tags: [Presensi]
 *     summary: Get today's attendance for logged-in employee
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Today's attendance retrieved successfully
 */
router.get('/attendance/today', authenticateToken, async (req, res) => {
  const connection = await getConnection();
  
  try {
    const karyawanId = req.user.id;
    const today = getCurrentDateWITA();

    // Get today's attendance records
    const [attendanceRows] = await connection.execute(`
      SELECT
        ad.*,
        TIME(ad.jam_masuk) AS jam_masuk,
        TIME(ad.jam_keluar) AS jam_keluar
      FROM presensi ad
      WHERE ad.id_karyawan = ? AND ad.tanggal = ?
      ORDER BY ad.tanggal ASC
    `, [karyawanId, today]);

    const checkInRecord = attendanceRows.length > 0 ? attendanceRows[0] : null;
    const checkOutRecord = checkInRecord && checkInRecord.jam_keluar ? checkInRecord : null;
    const breakData = extractBreakFromDataMasuk(checkInRecord?.data_masuk);
    const breakAllowanceMinutes = await getBreakAllowanceMinutes(connection);

    // Calculate work duration if both records exist
    let workDuration = null;
    let workDurationMinutes = null;
    if (checkInRecord && checkOutRecord) {
      const checkInDate = new Date(checkInRecord.tanggal).toISOString().split('T')[0];
      const checkInTime = new Date(`${checkInDate}T${checkInRecord.jam_masuk}`);
      const checkOutTime = new Date(`${checkInDate}T${checkOutRecord.jam_keluar}`);
      workDurationMinutes = Math.floor((checkOutTime - checkInTime) / (1000 * 60));
      const hours = Math.floor(workDurationMinutes / 60);
      const minutes = workDurationMinutes % 60;
      workDuration = `${hours} hours ${minutes} minutes`;
    }

    // Get work schedule
    const [scheduleRows] = await connection.execute(`
      SELECT
        ws.id,
        ws.nama AS nama,
        s.jam_masuk AS jam_masuk,
        s.jam_keluar AS jam_keluar,
        ws.hari_kerja AS hari_kerja
      FROM karyawan e
      LEFT JOIN jadwal_kerja ws ON e.id_jadwal_kerja = ws.id
      LEFT JOIN shift s ON s.id = COALESCE(e.shift_id, ws.shift_id)
      WHERE e.id = ?
      LIMIT 1
    `, [karyawanId]);

    let workSchedule = null;
    if (scheduleRows.length > 0) {
      const schedule = scheduleRows[0];
      const attendanceWindows = buildAttendanceWindows(schedule.jam_masuk, schedule.jam_keluar);
      workSchedule = {
        id: schedule.id,
        name: schedule.nama,
        start_time: schedule.jam_masuk,
        end_time: schedule.jam_keluar,
        clock_in_start: attendanceWindows.clock_in_start,
        clock_in_end: attendanceWindows.clock_in_end,
        clock_out_start: attendanceWindows.clock_out_start,
        clock_out_end: attendanceWindows.clock_out_end,
        work_days: parseWorkDays(schedule.hari_kerja)
      };
    }

    const response = {
      success: true,
      data: {
        date: today,
        // Kompatibilitas lama (snake_case)
        has_clocked_in: !!checkInRecord,
        has_clocked_out: !!checkOutRecord,
        clock_in: checkInRecord ? {
          time: checkInRecord.jam_masuk,
          status: checkInRecord.status,
          location: {
            latitude: null,
            longitude: null,
            distance: null
          },
          similarity: null
        } : null,
        clock_out: checkOutRecord ? {
          time: checkOutRecord.jam_keluar,
          status: checkOutRecord.status,
          location: {
            latitude: null,
            longitude: null,
            distance: null
          },
          similarity: null
        } : null,
        work_duration: workDuration,
        work_duration_minutes: workDurationMinutes,
        break: buildBreakResponse(breakData, !!checkInRecord, !!checkOutRecord, breakAllowanceMinutes),
        work_schedule: workSchedule,
        // Format utama untuk Android app (camelCase)
        hasCheckedIn: !!checkInRecord,
        hasCheckedOut: !!checkOutRecord,
        checkIn: checkInRecord ? {
          time: checkInRecord.jam_masuk,
          latitude: null,
          longitude: null,
          distance: null,
          similarity: null,
          photo: null
        } : null,
        checkOut: checkOutRecord ? {
          time: checkOutRecord.jam_keluar,
          latitude: null,
          longitude: null,
          distance: null,
          similarity: null,
          photo: null
        } : null,
        workDuration: workDuration,
        break: buildBreakResponse(breakData, !!checkInRecord, !!checkOutRecord, breakAllowanceMinutes),
        canCheckIn: !checkInRecord,
        canCheckOut: !!checkInRecord && !checkOutRecord
      }
    };

    res.json(response);

  } catch (error) {
    console.error('Get today attendance error:', error);
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
 * /api/attendance/history:
 *   get:
 *     tags: [Presensi]
 *     summary: Get attendance history for logged-in employee
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: tanggal_mulai
 *         schema:
 *           type: string
 *           format: date
 *         description: Start date filter (YYYY-MM-DD)
 *       - in: query
 *         name: tanggal_selesai
 *         schema:
 *           type: string
 *           format: date
 *         description: End date filter (YYYY-MM-DD)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Number of records to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of records to skip
 *     responses:
 *       200:
 *         description: "Riwayat presensi. Tiap record memuat clock in/out, lokasi, effective_work_minutes, overtime_minutes, break_minutes, approved_leave_minutes, dan menggantikan (nama karyawan yang digantikan bila menjadi pengganti disetujui pada hari itu)."
 */
router.get('/attendance/history', authenticateToken, async (req, res) => {
  const connection = await getConnection();
  
  try {
    const { tanggal_mulai, tanggal_selesai, limit = 50, offset = 0 } = req.query;
    const karyawanId = req.user.id;
    const breakAllowanceMinutes = await getBreakAllowanceMinutes(connection);

    let query = `
      SELECT
        ad.id,
        ad.tanggal as date,
        TIME(ad.jam_masuk) as clock_in_time,
        TIME(ad.jam_keluar) as clock_out_time,
        ad.status as status,
        ad.data_masuk,
        ad.data_keluar,
        ad.total_work_minutes,
        ad.approved_leave_minutes,
        ad.effective_work_minutes,
        ad.overtime_minutes,
        ad.late_minutes,
        ad.early_leave_minutes,
        (
          SELECT a.id FROM absensi a
          WHERE a.id_karyawan = ad.id_karyawan
            AND a.status IN ('approved', 'disetujui')
            AND ad.tanggal BETWEEN a.tanggal_mulai AND a.tanggal_selesai
          ORDER BY a.id DESC LIMIT 1
        ) AS leave_request_id,
        (
          SELECT ka.nama FROM permintaan_absensi pa
          JOIN absensi a2 ON a2.id = pa.id_absensi
          JOIN karyawan ka ON ka.id = a2.id_karyawan
          WHERE pa.id_pengganti = ad.id_karyawan
            AND pa.status = 'disetujui'
            AND a2.status = 'disetujui'
            AND ad.tanggal BETWEEN a2.tanggal_mulai AND a2.tanggal_selesai
          LIMIT 1
        ) AS menggantikan
      FROM presensi ad
      WHERE ad.id_karyawan = ?
        AND (ad.jam_masuk IS NOT NULL OR ad.jam_keluar IS NOT NULL)
    `;

    const params = [karyawanId];

    if (tanggal_mulai) {
      query += ' AND ad.tanggal >= ?';
      params.push(tanggal_mulai);
    }

    if (tanggal_selesai) {
      query += ' AND ad.tanggal <= ?';
      params.push(tanggal_selesai);
    }

    const limitNum = parseInt(limit);
    const offsetNum = parseInt(offset);
    query += ` ORDER BY ad.tanggal DESC, ad.jam_masuk DESC LIMIT ${limitNum} OFFSET ${offsetNum}`;

    const [rows] = await connection.execute(query, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) as total FROM presensi WHERE id_karyawan = ?';
    const countParams = [karyawanId];
    
    if (tanggal_mulai) {
      countQuery += ' AND tanggal >= ?';
      countParams.push(tanggal_mulai);
    }
    
    if (tanggal_selesai) {
      countQuery += ' AND tanggal <= ?';
      countParams.push(tanggal_selesai);
    }

    const [countRows] = await connection.execute(countQuery, countParams);
    const total = countRows[0].total;

    // Transform data to match Android model - one record per day with both clock in and clock out
    const records = rows.map(row => {
      const dataMasuk = parseJsonColumn(row.data_masuk);
      const dataKeluar = parseJsonColumn(row.data_keluar);
      const breakData = extractBreakFromDataMasuk(row.data_masuk);
      const countedBreakMinutes = getStoredOrCountedBreakMinutes(breakData, breakAllowanceMinutes);
      // Efektif diambil dari nilai tersimpan (dihitung benar saat clock-out; lihat utils/worktime.js).
      const effectiveWorkMinutes = Number(row.effective_work_minutes ?? 0);
      // Simple status: only "Tepat Waktu" or "Terlambat"
      // If no clock in/out, record won't appear (filtered by WHERE clause)
      let status = 'present';
      let statusLabel = 'Tepat Waktu';
      
      // Only check if late
      if (row.status === 'terlambat' || row.status === 'late') {
        status = 'late';
        statusLabel = 'Terlambat';
      }
      
      // Format date properly - convert Date object to yyyy-MM-dd string
      const dateStr = row.date instanceof Date 
        ? row.date.toISOString().split('T')[0]
        : (typeof row.date === 'string' ? row.date.split('T')[0] : row.date);
      
      return {
        id: row.id,
        date: dateStr,
        clockIn: row.clock_in_time ? {
          time: `${dateStr} ${row.clock_in_time}`,
          location: {
            latitude: dataMasuk.latitude ?? null,
            longitude: dataMasuk.longitude ?? null,
            distance: dataMasuk.jarak_meter ?? null,
            isValid: true
          },
          photo: dataMasuk.foto ?? null
        } : null,
        clockOut: row.clock_out_time ? {
          time: `${dateStr} ${row.clock_out_time}`,
          location: {
            latitude: dataKeluar.latitude ?? null,
            longitude: dataKeluar.longitude ?? null,
            distance: dataKeluar.jarak_meter ?? null,
            isValid: true
          },
          photo: dataKeluar.foto ?? null
        } : null,
        status: status,
        statusLabel: statusLabel,
        hasClockIn: !!row.clock_in_time,
        hasClockOut: !!row.clock_out_time,
        total_work_minutes: row.total_work_minutes ?? 0,
        approved_leave_minutes: row.approved_leave_minutes ?? 0,
        effective_work_minutes: effectiveWorkMinutes,
        overtime_minutes: row.overtime_minutes ?? 0,
        late_minutes: row.late_minutes ?? 0,
        early_leave_minutes: row.early_leave_minutes ?? 0,
        break_minutes: countedBreakMinutes,
        data_istirahat: breakData,
        leave_request_id: row.leave_request_id ?? null,
        menggantikan: row.menggantikan ?? null
      };
    });

    res.json({
      success: true,
      message: 'Attendance history retrieved successfully',
      data: {
        records: records,
        pagination: {
          total: total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          has_more: (parseInt(offset) + parseInt(limit)) < total
        }
      }
    });

  } catch (error) {
    console.error('Get attendance history error:', error);
    console.error('Error stack:', error.stack);
    console.error('Error message:', error.message);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'SERVER_ERROR',
      error: error.message
    });
  } finally {
    await connection.end();
  }
});

/**
 * @swagger
 * /api/attendance/summary:
 *   get:
 *     tags: [Presensi]
 *     summary: Ringkasan presensi bulanan untuk user login
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 12
 *         description: Bulan (1-12), default bulan sekarang
 *       - in: query
 *         name: year
 *         schema:
 *           type: integer
 *         description: Tahun (YYYY), default tahun sekarang
 *     responses:
 *       200:
 *         description: Ringkasan presensi berhasil diambil
 */
router.get('/attendance/summary', authenticateToken, async (req, res) => {
  const connection = await getConnection();

  try {
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    const month = Number.parseInt(req.query.month, 10) || currentMonth;
    const year = Number.parseInt(req.query.year, 10) || currentYear;

    if (month < 1 || month > 12) {
      return res.status(400).json({
        success: false,
        message: 'Invalid month',
        code: 'INVALID_MONTH'
      });
    }

    if (year < 2000 || year > 3000) {
      return res.status(400).json({
        success: false,
        message: 'Invalid year',
        code: 'INVALID_YEAR'
      });
    }

    const karyawanId = req.user.id;
    const breakAllowanceMinutes = await getBreakAllowanceMinutes(connection);

    const [rows] = await connection.execute(
      `SELECT
         tanggal,
         jam_masuk,
         jam_keluar,
         status,
         total_work_minutes,
         approved_leave_minutes,
         effective_work_minutes,
         overtime_minutes,
         late_minutes,
         early_leave_minutes,
         data_masuk,
         (
           SELECT a.id FROM absensi a
           WHERE a.id_karyawan = presensi.id_karyawan
             AND a.status IN ('approved', 'disetujui')
             AND presensi.tanggal BETWEEN a.tanggal_mulai AND a.tanggal_selesai
           ORDER BY a.id DESC LIMIT 1
         ) AS leave_request_id
       FROM presensi
       WHERE id_karyawan = ?
         AND MONTH(tanggal) = ?
         AND YEAR(tanggal) = ?
       ORDER BY tanggal ASC`,
      [karyawanId, month, year]
    );

    const toDuration = (minutes) => {
      const safeMinutes = Number(minutes || 0);
      const hh = String(Math.floor(safeMinutes / 60)).padStart(2, '0');
      const mm = String(safeMinutes % 60).padStart(2, '0');
      return `${hh}:${mm}`;
    };

    let presentDays = 0;
    let absentDays = 0;
    let lateDays = 0;
    let totalWorkMinutes = 0;

    const dailyRecords = rows.map((row) => {
      const status = String(row.status || '').toLowerCase();
      const breakData = extractBreakFromDataMasuk(row.data_masuk);
      const countedBreakMinutes = getStoredOrCountedBreakMinutes(breakData, breakAllowanceMinutes);
      // Efektif diambil dari nilai tersimpan (dihitung benar saat clock-out; lihat utils/worktime.js).
      const effectiveWorkMinutes = Number(row.effective_work_minutes ?? 0);
      if (status === 'late') {
        lateDays += 1;
        presentDays += 1;
      } else if (status === 'present') {
        presentDays += 1;
      } else if (status === 'absent') {
        absentDays += 1;
      }

      totalWorkMinutes += effectiveWorkMinutes;

      const tanggal = row.tanggal instanceof Date
        ? row.tanggal.toISOString().split('T')[0]
        : String(row.tanggal).split('T')[0];

      return {
        tanggal,
        jam_masuk: row.jam_masuk ? String(row.jam_masuk).split(' ')[1] || row.jam_masuk : null,
        jam_keluar: row.jam_keluar ? String(row.jam_keluar).split(' ')[1] || row.jam_keluar : null,
        work_duration: toDuration(effectiveWorkMinutes),
        status: row.status,
        total_work_minutes: row.total_work_minutes ?? 0,
        approved_leave_minutes: row.approved_leave_minutes ?? 0,
        effective_work_minutes: effectiveWorkMinutes,
        overtime_minutes: row.overtime_minutes ?? 0,
        late_minutes: row.late_minutes ?? 0,
        early_leave_minutes: row.early_leave_minutes ?? 0,
        break_minutes: countedBreakMinutes,
        data_istirahat: breakData,
        leave_request_id: row.leave_request_id ?? null
      };
    });

    const totalDays = rows.length;
    const averageWorkMinutes = totalDays > 0 ? Math.round(totalWorkMinutes / totalDays) : 0;

    return res.json({
      success: true,
      message: 'Attendance summary retrieved successfully',
      data: {
        month,
        year,
        total_days: totalDays,
        present_days: presentDays,
        absent_days: absentDays,
        late_days: lateDays,
        total_work_hours: toDuration(totalWorkMinutes),
        average_work_hours: toDuration(averageWorkMinutes),
        daily_records: dailyRecords
      }
    });
  } catch (error) {
    console.error('Get attendance summary error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'SERVER_ERROR'
    });
  } finally {
    await connection.end();
  }
});

// ============================================
// VALIDATION APIs (Validasi)
// Endpoint untuk validasi lokasi dan wajah
// ============================================

/**
 * @swagger
 * /api/validation/location:
 *   post:
 *     tags: [Validation]
 *     summary: Validasi lokasi GPS dalam radius kantor
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - latitude
 *               - longitude
 *             properties:
 *               latitude:
 *                 type: number
 *                 description: Latitude lokasi user
 *                 example: -6.200000
 *               longitude:
 *                 type: number
 *                 description: Longitude lokasi user
 *                 example: 106.816666
 *     responses:
 *       200:
 *         description: Hasil validasi lokasi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     isValid:
 *                       type: boolean
 *                       example: true
 *                     distance:
 *                       type: integer
 *                       example: 45
 *                       description: Jarak dalam meter
 *                     allowedRadius:
 *                       type: integer
 *                       example: 100
 *                       description: Radius yang diizinkan dalam meter
 *                     officeLocation:
 *                       type: object
 *                       properties:
 *                         latitude:
 *                           type: number
 *                         longitude:
 *                           type: number
 */
router.post('/validation/location', authenticateToken, async (req, res) => {
  const connection = await getConnection();
  
  try {
    const { latitude, longitude } = req.body;

    if (!latitude || !longitude) {
      return res.status(400).json({
        success: false,
        message: 'Latitude and longitude are required',
        code: 'MISSING_COORDINATES'
      });
    }

    console.log(`[Location Validation] User: ${req.user.nik}, Lat: ${latitude}, Lng: ${longitude}`);

    // Get office location settings (v2)
    const [settingsRows] = await connection.execute(`
      SELECT
        lat_kantor AS lat_kantor,
        long_kantor AS long_kantor,
        radius_meter
      FROM pengaturan
      LIMIT 1
    `);

    if (settingsRows.length === 0) {
      console.log('[Location Validation] ERROR: No office location configured');
      return res.status(500).json({
        success: false,
        message: 'Office location not configured',
        code: 'NO_OFFICE_LOCATION'
      });
    }

    const settings = settingsRows[0];
    console.log(`[Location Validation] Office: Lat ${settings.lat_kantor}, Lng ${settings.long_kantor}, Radius ${settings.radius_meter}m`);

    // Validate location
    const locationValidation = isLocationValid(
      parseFloat(latitude),
      parseFloat(longitude),
      parseFloat(settings.lat_kantor),
      parseFloat(settings.long_kantor),
      settings.radius_meter
    );

    console.log(`[Location Validation] Result: isValid=${locationValidation.isValid}, distance=${locationValidation.distance}m`);

    res.json({
      success: true,
      data: {
        isValid: locationValidation.isValid,
        distance: locationValidation.distance,
        allowedRadius: locationValidation.allowedRadius,
        officeLocation: {
          latitude: parseFloat(settings.lat_kantor),
          longitude: parseFloat(settings.long_kantor)
        },
        userLocation: {
          latitude: parseFloat(latitude),
          longitude: parseFloat(longitude)
        }
      }
    });

  } catch (error) {
    console.error('Location validation error:', error);
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
 * /api/validation/face-match:
 *   post:
 *     tags: [Validation]
 *     summary: Validasi kecocokan wajah dengan referensi
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - photo
 *             properties:
 *               photo:
 *                 type: string
 *                 format: binary
 *                 description: Foto untuk face recognition
 *     responses:
 *       200:
 *         description: Hasil validasi wajah
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     isMatch:
 *                       type: boolean
 *                       example: true
 *                     similarity:
 *                       type: number
 *                       example: 0.85
 *                     confidence:
 *                       type: string
 *                       example: "Tinggi"
 *                     threshold:
 *                       type: number
 *                       example: 0.65
 *                     facesDetected:
 *                       type: integer
 *                       example: 1
 *                     faces:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: integer
 *                           box:
 *                             type: object
 *                             properties:
 *                               xMin:
 *                                 type: integer
 *                               yMin:
 *                                 type: integer
 *                               xMax:
 *                                 type: integer
 *                               yMax:
 *                                 type: integer
 *                               width:
 *                                 type: integer
 *                               height:
 *                                 type: integer
 *                           confidence:
 *                             type: number
 */
router.post('/validation/face-match', authenticateToken, upload.single('photo'), async (req, res) => {
  const connection = await getConnection();
  
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Photo is required',
        code: 'NO_PHOTO'
      });
    }

    // Get employee's face reference (v2)
    const [faceRows] = await connection.execute(
      `SELECT
        id,
        id_karyawan AS id_karyawan,
        face_encoding,
        photo_path,
        created_at,
        is_active
      FROM karyawan_face_reference
      WHERE id_karyawan = ? AND is_active = TRUE`,
      [req.user.id]
    );

    if (faceRows.length === 0) {
      // Delete uploaded file
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      
      return res.status(400).json({
        success: false,
        message: 'No face reference found. Please complete activation first.',
        code: 'NO_FACE_REFERENCE'
      });
    }

    let referenceFaces;
    try {
      referenceFaces = extractReferenceFaces(faceRows);
    } catch (error) {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(500).json({
        success: false,
        message: 'Invalid face reference data',
        code: 'INVALID_FACE_DATA'
      });
    }

    // Detect faces in uploaded photo
    const detectedFaces = await detectFaces(req.file.path);

    // Delete uploaded file after processing (validation doesn't need to keep the file)
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    if (detectedFaces.length === 0) {
      return res.json({
        success: true,
        data: {
          isMatch: false,
          similarity: 0,
          confidence: 'Rendah',
          threshold: 0.65,
          facesDetected: 0,
          faces: [],
          message: 'No faces detected in photo'
        }
      });
    }

    // Compare faces
    const matchResults = await compareFaces(referenceFaces, detectedFaces);
    const bestMatch = matchResults.find(result => result.isMatch) || matchResults[0];

    res.json({
      success: true,
      data: {
        isMatch: bestMatch.isMatch,
        similarity: bestMatch.similarity,
        confidence: bestMatch.confidence,
        threshold: bestMatch.threshold,
        facesDetected: detectedFaces.length,
        faces: detectedFaces,
        matchResults: matchResults,
        referenceInfo: {
          facesCount: referenceFaces.length,
          uploadTime: faceRows[0]?.created_at || null
        }
      }
    });

  } catch (error) {
    console.error('Face validation error:', error);
    
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

// ============================================
// SETTINGS API (Pengaturan)
// Endpoint untuk mengambil pengaturan sistem
// ============================================

/**
 * @swagger
 * /api/settings/office-location:
 *   get:
 *     tags: [Settings]
 *     summary: Get koordinat kantor dan radius yang diizinkan
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Data lokasi kantor
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     latitude:
 *                       type: number
 *                       example: -6.200000
 *                       description: Latitude kantor
 *                     longitude:
 *                       type: number
 *                       example: 106.816666
 *                       description: Longitude kantor
 *                     radius:
 *                       type: integer
 *                       example: 100
 *                       description: Radius yang diizinkan dalam meter
 *                     breakDurationMinutes:
 *                       type: integer
 *                       example: 60
 *                       description: Jatah istirahat harian dalam menit
 *                     durasi_istirahat_menit:
 *                       type: integer
 *                       example: 60
 *                       description: Jatah istirahat harian dalam menit
 *                     address:
 *                       type: string
 *                       example: "Jakarta, Indonesia"
 *                       description: Alamat kantor (optional)
 */
router.get('/settings/office-location', authenticateToken, async (req, res) => {
  const connection = await getConnection();
  
  try {
    // Get office location settings (v2)
    const [settingsRows] = await connection.execute(`
      SELECT
        lat_kantor AS lat_kantor,
        long_kantor AS long_kantor,
        radius_meter,
        durasi_istirahat_menit
      FROM pengaturan
      LIMIT 1
    `);

    if (settingsRows.length === 0) {
      return res.status(500).json({
        success: false,
        message: 'Office location not configured',
        code: 'NO_OFFICE_LOCATION'
      });
    }

    const settings = settingsRows[0];

    res.json({
      success: true,
      message: 'Office location retrieved successfully',
      data: {
        latitude: parseFloat(settings.lat_kantor),
        longitude: parseFloat(settings.long_kantor),
        radiusMeters: parseFloat(settings.radius_meter), // Changed from radius to radiusMeters
        breakDurationMinutes: Number(settings.durasi_istirahat_menit) || DEFAULT_BREAK_ALLOWANCE_MINUTES,
        durasi_istirahat_menit: Number(settings.durasi_istirahat_menit) || DEFAULT_BREAK_ALLOWANCE_MINUTES,
        address: null // Optional field for future use
      }
    });

  } catch (error) {
    console.error('Get office location error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'SERVER_ERROR'
    });
  } finally {
    await connection.end();
  }
});
// ============================================
// ADMIN TESTING APIs (Development Only)
// Endpoint untuk testing face recognition
// CATATAN: Hanya untuk development, disable di production!
// ============================================

/**
 * @swagger
 * /api/admin/test/upload-reference:
 *   post:
 *     tags: [Admin Testing]
 *     summary: Upload foto referensi untuk testing (Admin only)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - reference
 *             properties:
 *               reference:
 *                 type: string
 *                 format: binary
 *                 description: Foto referensi untuk testing
 *     responses:
 *       200:
 *         description: Foto referensi testing berhasil diupload
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Test reference photo uploaded successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     testId:
 *                       type: string
 *                     facesDetected:
 *                       type: integer
 *                     faces:
 *                       type: array
 *                       items:
 *                         type: object
 */
router.post('/admin/test/upload-reference', authenticateToken, upload.single('reference'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No image file provided',
        code: 'NO_FILE'
      });
    }

    const imagePath = req.file.path;
    
    // Detect faces using AI
    const faces = await detectFaces(imagePath);
    
    if (faces.length === 0) {
      // Delete uploaded file if no faces detected
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
      return res.status(400).json({
        success: false,
        message: 'No faces detected in the image',
        code: 'NO_FACES'
      });
    }

    // Store reference data temporarily (in memory or temp file)
    const testId = `test_${Date.now()}_${req.user.id}`;
    
    // For testing purposes, we'll store in a simple way
    // In production, you might want to use Redis or temporary database
    global.testReferences = global.testReferences || {};
    global.testReferences[testId] = {
      filename: req.file.filename,
      originalName: req.file.originalname,
      filePath: imagePath,
      faces: faces,
      uploadTime: new Date().toISOString(),
      userId: req.user.id
    };

    res.json({
      success: true,
      message: 'Test reference photo uploaded successfully',
      data: {
        testId: testId,
        filename: req.file.filename,
        originalName: req.file.originalname,
        facesDetected: faces.length,
        faces: faces,
        uploadTime: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Upload test reference error:', error);
    
    // Delete uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to process test reference image',
      code: 'PROCESSING_ERROR'
    });
  }
});

/**
 * @swagger
 * /api/admin/test/match-face:
 *   post:
 *     tags: [Admin Testing]
 *     summary: Test face matching dengan referensi (Admin only)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - photo
 *               - testId
 *             properties:
 *               photo:
 *                 type: string
 *                 format: binary
 *                 description: Foto untuk dicocokkan
 *               testId:
 *                 type: string
 *                 description: ID referensi test dari upload-reference
 *     responses:
 *       200:
 *         description: Hasil test face matching
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Face matching test completed"
 *                 data:
 *                   type: object
 *                   properties:
 *                     testId:
 *                       type: string
 *                     facesDetected:
 *                       type: integer
 *                     matchResults:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           isMatch:
 *                             type: boolean
 *                           similarity:
 *                             type: number
 *                           confidence:
 *                             type: string
 */
router.post('/admin/test/match-face', authenticateToken, upload.single('photo'), async (req, res) => {
  try {
    const { testId } = req.body;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No image file provided',
        code: 'NO_FILE'
      });
    }

    if (!testId) {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({
        success: false,
        message: 'Test ID is required',
        code: 'NO_TEST_ID'
      });
    }

    // Get test reference data
    global.testReferences = global.testReferences || {};
    const testReference = global.testReferences[testId];

    if (!testReference) {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({
        success: false,
        message: 'Test reference not found. Please upload reference first.',
        code: 'NO_TEST_REFERENCE'
      });
    }

    const imagePath = req.file.path;
    
    // Detect faces in uploaded photo
    const detectedFaces = await detectFaces(imagePath);

    // Delete uploaded file after processing
    if (fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
    }

    if (detectedFaces.length === 0) {
      return res.json({
        success: true,
        message: 'Face matching test completed',
        data: {
          testId: testId,
          facesDetected: 0,
          faces: [],
          matchResults: [],
          message: 'No faces detected in test photo'
        }
      });
    }

    // Compare faces with test reference
    const matchResults = await compareFaces(testReference.faces, detectedFaces);

    res.json({
      success: true,
      message: 'Face matching test completed',
      data: {
        testId: testId,
        facesDetected: detectedFaces.length,
        faces: detectedFaces,
        matchResults: matchResults,
        reference: {
          filename: testReference.originalName,
          facesCount: testReference.faces.length,
          uploadTime: testReference.uploadTime
        },
        summary: {
          totalFaces: detectedFaces.length,
          matchedFaces: matchResults.filter(r => r.isMatch).length,
          averageSimilarity: matchResults.length > 0 ? 
            (matchResults.reduce((sum, r) => sum + r.similarity, 0) / matchResults.length).toFixed(4) : 0,
          highestSimilarity: matchResults.length > 0 ? 
            Math.max(...matchResults.map(r => r.similarity)).toFixed(4) : 0
        }
      }
    });

  } catch (error) {
    console.error('Test face matching error:', error);
    
    // Delete uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to test face matching',
      code: 'PROCESSING_ERROR'
    });
  }
});

/**
 * @swagger
 * /api/admin/test/realtime-match:
 *   post:
 *     tags: [Admin Testing]
 *     summary: Real-time face matching test (Admin only)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - frame
 *               - testId
 *             properties:
 *               frame:
 *                 type: string
 *                 format: binary
 *                 description: Frame dari camera untuk real-time matching
 *               testId:
 *                 type: string
 *                 description: ID referensi test
 *     responses:
 *       200:
 *         description: Hasil real-time face matching
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     testId:
 *                       type: string
 *                     facesDetected:
 *                       type: integer
 *                     matchResults:
 *                       type: array
 *                       items:
 *                         type: object
 *                     timestamp:
 *                       type: string
 */
router.post('/admin/test/realtime-match', authenticateToken, upload.single('frame'), async (req, res) => {
  try {
    const { testId } = req.body;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No frame provided',
        code: 'NO_FRAME'
      });
    }

    if (!testId) {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({
        success: false,
        message: 'Test ID is required',
        code: 'NO_TEST_ID'
      });
    }

    // Get test reference data
    global.testReferences = global.testReferences || {};
    const testReference = global.testReferences[testId];

    if (!testReference) {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({
        success: false,
        message: 'Test reference not found',
        code: 'NO_TEST_REFERENCE'
      });
    }

    const imagePath = req.file.path;
    
    try {
      // Detect faces in frame
      const detectedFaces = await detectFaces(imagePath);

      // Delete frame immediately after processing
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }

      if (detectedFaces.length === 0) {
        return res.json({
          success: true,
          data: {
            testId: testId,
            facesDetected: 0,
            faces: [],
            matchResults: [],
            timestamp: new Date().toISOString()
          }
        });
      }

      // Compare faces (no database save for real-time)
      const matchResults = await compareFaces(testReference.faces, detectedFaces);

      res.json({
        success: true,
        data: {
          testId: testId,
          facesDetected: detectedFaces.length,
          faces: detectedFaces,
          matchResults: matchResults,
          summary: {
            totalFaces: detectedFaces.length,
            matchedFaces: matchResults.filter(r => r.isMatch).length,
            averageSimilarity: matchResults.length > 0 ? 
              (matchResults.reduce((sum, r) => sum + r.similarity, 0) / matchResults.length).toFixed(4) : 0,
            highestSimilarity: matchResults.length > 0 ? 
              Math.max(...matchResults.map(r => r.similarity)).toFixed(4) : 0
          },
          timestamp: new Date().toISOString()
        }
      });

    } catch (processingError) {
      // Ensure frame is deleted even if processing fails
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
      throw processingError;
    }

  } catch (error) {
    console.error('Real-time test matching error:', error);
    
    // Delete uploaded frame on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to process real-time frame',
      code: 'PROCESSING_ERROR'
    });
  }
});

/**
 * @swagger
 * /api/face/detect-realtime:
 *   post:
 *     tags: [Face Recognition]
 *     summary: Detect faces in realtime frame (for Android)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - frame
 *             properties:
 *               frame:
 *                 type: string
 *                 format: binary
 *                 description: Camera frame image
 *     responses:
 *       200:
 *         description: Face detection successful
 */
router.post('/face/detect-realtime', authenticateToken, upload.single('frame'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No frame provided',
        code: 'NO_FRAME'
      });
    }

    const imagePath = req.file.path;

    try {
      // Detect faces in frame
      const detectedFaces = await detectFaces(imagePath);

      // Delete frame immediately after processing
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }

      res.json({
        success: true,
        data: {
          facesDetected: detectedFaces.length,
          faces: detectedFaces.map(face => ({
            box: face.box,
            confidence: face.confidence || 1.0
          })),
          timestamp: new Date().toISOString()
        }
      });

    } catch (processingError) {
      // Ensure frame is deleted even if processing fails
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
      throw processingError;
    }

  } catch (error) {
    console.error('Realtime face detection error:', error);
    
    // Delete uploaded frame on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to detect faces',
      code: 'DETECTION_ERROR'
    });
  }
});


module.exports = router;
module.exports.checkDatabaseConnection = checkDatabaseConnection;
