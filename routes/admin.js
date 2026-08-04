const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const dbOriginal = require('../config/database');
const {
    createUploadStorage,
    deleteStoredFile,
    discardUploadedFile,
    getBlobPathnameFromUrl,
    isBlobStorageConfigured,
    isRemoteFileUrl,
    listBlobFilesByPrefixes,
    persistUploadedFile
} = require('../utils/upload-storage');
const { recalcPresensiForLeave, recalcSubstitutePresensiForLeave } = require('../utils/presensi-recalc');

// Wrapper to make db.query work with both callbacks and promises
const db = {
    query: function(sql, paramsOrCallback, callback) {
        // If only 2 args and second is function, it's (sql, callback)
        if (typeof paramsOrCallback === 'function') {
            callback = paramsOrCallback;
            paramsOrCallback = [];
        } else if (paramsOrCallback == null) {
            paramsOrCallback = [];
        }
        
        // If callback provided, use callback style
        if (callback) {
            dbOriginal.query(sql, paramsOrCallback)
                .then(results => callback(null, results))
                .catch(err => callback(err));
        } else {
            // No callback, return promise
            return dbOriginal.query(sql, paramsOrCallback);
        }
    }
};

const { requireAuth, redirectIfAuth } = require('../middleware/auth');

/**
 * WITA Timezone Helper Functions
 */
function getCurrentTimeWITA() {
    const now = new Date();
    const witaTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Makassar' }));
    const hours = String(witaTime.getHours()).padStart(2, '0');
    const minutes = String(witaTime.getMinutes()).padStart(2, '0');
    const seconds = String(witaTime.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

function getCurrentDateWITA() {
    const now = new Date();
    const witaTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Makassar' }));
    const year = witaTime.getFullYear();
    const month = String(witaTime.getMonth() + 1).padStart(2, '0');
    const day = String(witaTime.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Sama seperti isDevScheduleBypassEnabled di routes/api.js: ENFORCE_SCHEDULE=true mematikan
// bypass dev walau NODE_ENV=development; selain itu ikut mode development.
function isDevScheduleBypassEnabled() {
    if (String(process.env.ENFORCE_SCHEDULE || '').toLowerCase() === 'true') return false;
    return (process.env.NODE_ENV || 'development') === 'development';
}

// Selisih menit antara dua jam "HH:MM" (durasi izin sebagian)
function menitAntaraJam(a, b) {
    const parse = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '').trim()); return m ? (Number(m[1]) * 60 + Number(m[2])) : NaN; };
    const x = parse(a), y = parse(b);
    if (Number.isNaN(x) || Number.isNaN(y)) return 0;
    return Math.max(0, y - x);
}

function getDateWITA(daysOffset = 0) {
    const now = new Date();
    const witaTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Makassar' }));
    witaTime.setDate(witaTime.getDate() + daysOffset);
    const year = witaTime.getFullYear();
    const month = String(witaTime.getMonth() + 1).padStart(2, '0');
    const day = String(witaTime.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function parseJsonArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try {
        return JSON.parse(value);
    } catch (error) {
        return [];
    }
}

const UPLOAD_CLEANUP_DIRECTORIES = [
    {
        key: 'karyawan',
        label: 'Foto karyawan',
        diskPath: path.join(__dirname, '..', 'public', 'uploads', 'karyawan'),
        publicPrefix: '/uploads/karyawan'
    },
    {
        key: 'presensi',
        label: 'Foto presensi',
        diskPath: path.join(__dirname, '..', 'public', 'uploads', 'presensi'),
        publicPrefix: '/uploads/presensi'
    },
    {
        key: 'profiles',
        label: 'Foto profil',
        diskPath: path.join(__dirname, '..', 'public', 'uploads', 'profiles'),
        publicPrefix: '/uploads/profiles'
    },
    {
        key: 'leave',
        label: 'Lampiran absensi',
        diskPath: path.join(__dirname, '..', 'public', 'uploads', 'leave'),
        publicPrefix: '/uploads/leave'
    },
    {
        key: 'faces',
        label: 'Face reference legacy',
        diskPath: path.join(__dirname, '..', 'uploads', 'faces'),
        publicPrefix: '/uploads/faces'
    },
    {
        key: 'test',
        label: 'File test',
        diskPath: path.join(__dirname, '..', 'uploads', 'test'),
        publicPrefix: '/uploads/test'
    }
];

const UPLOAD_CLEANUP_PREFIXES = [
    'uploads/karyawan/',
    'uploads/presensi/',
    'uploads/profiles/',
    'uploads/leave/',
    'uploads/faces/',
    'uploads/test/'
];

const IMAGE_PREVIEW_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const IGNORED_UPLOAD_FILENAMES = new Set(['.gitkeep']);

function encodeUploadFileId(bucket, relativePath) {
    return Buffer.from(JSON.stringify({ bucket, path: relativePath }), 'utf8').toString('base64url');
}

function decodeUploadFileId(fileId) {
    if (!fileId || typeof fileId !== 'string') {
        throw new Error('File tidak valid');
    }

    const decoded = JSON.parse(Buffer.from(fileId, 'base64url').toString('utf8'));
    if (!decoded.bucket || !decoded.path || typeof decoded.path !== 'string') {
        throw new Error('File tidak valid');
    }

    return decoded;
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, index);
    return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatUploadDate(date) {
    return new Intl.DateTimeFormat('id-ID', {
        timeZone: 'Asia/Makassar',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    }).format(date);
}

function getFileKind(extension) {
    if (IMAGE_PREVIEW_EXTENSIONS.has(extension)) return 'Foto';
    if (extension === '.pdf') return 'PDF';
    if (['.doc', '.docx'].includes(extension)) return 'Dokumen';
    if (['.xls', '.xlsx', '.csv'].includes(extension)) return 'Spreadsheet';
    if (['.zip', '.rar', '.7z'].includes(extension)) return 'Arsip';
    return extension ? extension.replace('.', '').toUpperCase() : 'File';
}

async function walkUploadDirectory(bucket, currentDir = bucket.diskPath, nestedPath = '') {
    let entries;
    try {
        entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }

    const files = [];
    for (const entry of entries) {
        if (IGNORED_UPLOAD_FILENAMES.has(entry.name) || entry.isSymbolicLink()) {
            continue;
        }

        const relativePath = path.join(nestedPath, entry.name);
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
            files.push(...await walkUploadDirectory(bucket, fullPath, relativePath));
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        const stat = await fs.promises.stat(fullPath);
        const relativeWebPath = relativePath.split(path.sep).join('/');
        const extension = path.extname(entry.name).toLowerCase();
        files.push({
            id: encodeUploadFileId(bucket.key, relativePath),
            bucket: bucket.key,
            bucketLabel: bucket.label,
            name: entry.name,
            relativePath: relativeWebPath,
            publicPath: `${bucket.publicPrefix}/${relativeWebPath}`,
            extension,
            kind: getFileKind(extension),
            isImage: IMAGE_PREVIEW_EXTENSIONS.has(extension),
            size: stat.size,
            sizeLabel: formatBytes(stat.size),
            modifiedAt: stat.mtime,
            modifiedAtLabel: formatUploadDate(stat.mtime)
        });
    }

    return files;
}

async function listUploadFiles() {
    const fileGroups = await Promise.all(UPLOAD_CLEANUP_DIRECTORIES.map(bucket => walkUploadDirectory(bucket)));
    const localFiles = fileGroups.flat();
    let blobFiles = [];

    if (isBlobStorageConfigured()) {
        const blobs = await listBlobFilesByPrefixes(UPLOAD_CLEANUP_PREFIXES);
        blobFiles = blobs.map((blob) => {
            const name = path.posix.basename(blob.pathname);
            const extension = path.extname(name).toLowerCase();
            const folder = UPLOAD_CLEANUP_DIRECTORIES.find((item) => blob.pathname.startsWith(item.publicPrefix.replace(/^\//, '') + '/'));
            return {
                id: encodeUploadFileId('blob', blob.url),
                bucket: 'blob',
                bucketLabel: folder ? `${folder.label} (Blob)` : 'Vercel Blob',
                name,
                relativePath: blob.pathname,
                publicPath: blob.url,
                extension,
                kind: getFileKind(extension),
                isImage: IMAGE_PREVIEW_EXTENSIONS.has(extension),
                size: blob.size || 0,
                sizeLabel: formatBytes(blob.size || 0),
                modifiedAt: blob.uploadedAt ? new Date(blob.uploadedAt) : new Date(0),
                modifiedAtLabel: blob.uploadedAt ? formatUploadDate(new Date(blob.uploadedAt)) : '-'
            };
        });
    }

    return [...blobFiles, ...localFiles]
        .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

function getUploadStats(files) {
    const byBucket = UPLOAD_CLEANUP_DIRECTORIES.map(bucket => {
        const blobPrefix = `${bucket.publicPrefix.replace(/^\//, '')}/`;
        const bucketFiles = files.filter(file => file.bucket === bucket.key || file.relativePath.startsWith(blobPrefix));
        const totalSize = bucketFiles.reduce((sum, file) => sum + file.size, 0);
        return {
            key: bucket.key,
            label: bucket.label,
            count: bucketFiles.length,
            totalSize,
            sizeLabel: formatBytes(totalSize)
        };
    });
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    return {
        totalFiles: files.length,
        totalSize,
        totalSizeLabel: formatBytes(totalSize),
        byBucket
    };
}

function resolveUploadFile(fileId) {
    const decoded = decodeUploadFileId(fileId);
    if (decoded.bucket === 'blob') {
        if (!isRemoteFileUrl(decoded.path)) {
            throw new Error('URL Blob tidak valid');
        }
        return {
            bucket: { key: 'blob', label: 'Vercel Blob' },
            fullPath: decoded.path,
            relativePath: getBlobPathnameFromUrl(decoded.path) || decoded.path,
            isBlob: true
        };
    }

    const bucket = UPLOAD_CLEANUP_DIRECTORIES.find(item => item.key === decoded.bucket);
    if (!bucket) {
        throw new Error('Folder upload tidak valid');
    }

    const normalizedRelativePath = path.normalize(decoded.path);
    if (path.isAbsolute(normalizedRelativePath) || normalizedRelativePath.startsWith('..')) {
        throw new Error('Path file tidak valid');
    }

    const basePath = path.resolve(bucket.diskPath);
    const fullPath = path.resolve(bucket.diskPath, normalizedRelativePath);
    if (!fullPath.startsWith(basePath + path.sep)) {
        throw new Error('Path file tidak valid');
    }

    return {
        bucket,
        fullPath,
        relativePath: normalizedRelativePath
    };
}

function normalizeFileIds(fileIds) {
    if (!fileIds) return [];
    return Array.isArray(fileIds) ? fileIds.filter(Boolean) : [fileIds].filter(Boolean);
}

async function deleteUploadFileById(fileId) {
    const target = resolveUploadFile(fileId);
    if (target.isBlob) {
        await deleteStoredFile(target.fullPath);
        return path.posix.basename(target.relativePath);
    }

    const stat = await fs.promises.lstat(target.fullPath);
    if (!stat.isFile() || IGNORED_UPLOAD_FILENAMES.has(path.basename(target.fullPath))) {
        throw new Error('Target bukan file upload');
    }

    await fs.promises.unlink(target.fullPath);
    return path.basename(target.fullPath);
}

async function deleteUploadFilesByIds(fileIds) {
    const uniqueFileIds = [...new Set(normalizeFileIds(fileIds))];
    const result = {
        deleted: [],
        errors: []
    };

    for (const fileId of uniqueFileIds) {
        try {
            const deletedName = await deleteUploadFileById(fileId);
            result.deleted.push(deletedName);
        } catch (error) {
            result.errors.push(error.message);
        }
    }

    return result;
}

const router = express.Router();
/**
 * IMPORTANT: This file uses db.query() which returns promises.
 * All routes should use async/await pattern:
 * 
 * router.get('/route', requireAuth, async (req, res) => {
 *   try {
 *     const results = await db.query('SELECT * FROM table');
 *     // handle results
 *   } catch (err) {
 *     // handle error
 *   }
 * });
 */

function isManagerSession(req) {
    return req.session?.admin?.role === 'manager';
}

function requireSuperAdmin(req, res, next) {
    if (isManagerSession(req)) {
        req.flash('error', 'Akses khusus admin utama');
        return res.redirect('/admin/absensi');
    }
    return next();
}

function requireManager(req, res, next) {
    if (!isManagerSession(req)) {
        req.flash('error', 'Menu approval khusus manager');
        return res.redirect('/admin/dashboard');
    }
    return next();
}

function getListParams(req, options = {}) {
    const defaultLimit = options.defaultLimit || 10;
    const maxLimit = options.maxLimit || 100;
    const rawPage = Number.parseInt(req.query.page, 10);
    const rawLimit = Number.parseInt(req.query.limit, 10);
    const page = Number.isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;
    const limit = Number.isNaN(rawLimit)
        ? defaultLimit
        : Math.min(maxLimit, Math.max(1, rawLimit));
    const q = (req.query.q || '').toString().trim();
    const offset = (page - 1) * limit;
    return { page, limit, q, offset };
}

function getPagination(totalItems, page, limit) {
    const safeTotal = Number.isFinite(totalItems) ? totalItems : 0;
    const safeLimit = limit > 0 ? limit : 10;
    const totalPages = Math.max(1, Math.ceil(safeTotal / safeLimit));
    const safePage = Math.min(Math.max(1, page), totalPages);
    return {
        totalItems: safeTotal,
        totalPages,
        page: safePage,
        limit: safeLimit,
        hasPrev: safePage > 1,
        hasNext: safePage < totalPages,
        prevPage: safePage > 1 ? safePage - 1 : 1,
        nextPage: safePage < totalPages ? safePage + 1 : totalPages,
        startItem: safeTotal === 0 ? 0 : ((safePage - 1) * safeLimit) + 1,
        endItem: safeTotal === 0 ? 0 : Math.min(safeTotal, safePage * safeLimit)
    };
}

function getSafeLimitOffset(pagination) {
    const safeLimit = Math.max(1, Number.parseInt(pagination?.limit, 10) || 10);
    const safePage = Math.max(1, Number.parseInt(pagination?.page, 10) || 1);
    const safeOffset = (safePage - 1) * safeLimit;
    return { safeLimit, safeOffset };
}

function getSafeAbsensiRedirect(req) {
    const referer = req.get('Referer') || '';
    try {
        const url = new URL(referer, `${req.protocol}://${req.get('host')}`);
        if (url.host === req.get('host') && url.pathname.startsWith('/admin/absensi')) {
            return `${url.pathname}${url.search}`;
        }
    } catch (error) {
        return '/admin/absensi';
    }
    return '/admin/absensi';
}


// Konfigurasi multer untuk upload foto referensi karyawan
const storage = multer.diskStorage(createUploadStorage({
    localDirectory: 'public/uploads/karyawan',
    filenamePrefix: 'ref'
}));

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: function (req, file, cb) {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed!'), false);
        }
    }
});

// Konfigurasi multer untuk testing (temporary uploads)
const testStorage = multer.diskStorage(createUploadStorage({
    localDirectory: 'uploads/test',
    filenamePrefix: 'test'
}));

const testUpload = multer({ 
    storage: testStorage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: function (req, file, cb) {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed!'), false);
        }
    }
});

// Login page
router.get('/login', redirectIfAuth, async (req, res) => {
    res.render('admin/login', { 
        title: 'Admin Login - Fleur Atelier',
        error: req.flash('error')
    });
});

// Login process
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    console.log('Login attempt:', { username, password: password ? '***' : 'empty' });
    
    if (!username || !password) {
        console.log('Missing username or password');
        req.flash('error', 'Username dan password harus diisi');
        return res.redirect('/admin/login');
    }

    try {
        // user table standalone: admin + manager web, tidak ada link ke karyawan
        const userRows = await db.query(
            'SELECT id, username, password, role FROM user WHERE username = ? LIMIT 1',
            [username]
        );

        if (userRows.length === 0) {
            req.flash('error', 'Username tidak ditemukan');
            return res.redirect('/admin/login');
        }

        const user = userRows[0];
        const isValidPassword = await bcrypt.compare(password, user.password);
        if (!isValidPassword) {
            req.flash('error', 'Password salah');
            return res.redirect('/admin/login');
        }

        const sessionPayload = {
            id: user.id,
            username: user.username,
            role: user.role === 'superadmin' ? 'admin' : user.role
        };
        const redirectPath = user.role === 'manager' ? '/admin/manager-dashboard' : '/admin/dashboard';

        req.session.admin = sessionPayload;
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                req.flash('error', 'Terjadi kesalahan saat menyimpan session');
                return res.redirect('/admin/login');
            }
            return res.redirect(redirectPath);
        });
    } catch (error) {
        console.error('Login error:', error);
        req.flash('error', 'Terjadi kesalahan sistem');
        return res.redirect('/admin/login');
    }
});

// Dashboard
router.get('/dashboard', requireAuth, async (req, res) => {
    if (isManagerSession(req)) {
        return res.redirect('/admin/manager-dashboard');
    }
    // Simple stats without complex query for now
    const defaultStats = {
        total_karyawan: 0,
        belum_aktivasi: 0,
        hadir_hari_ini: 0
    };

    try {
        const results = await db.query('SELECT COUNT(*) as total FROM karyawan WHERE deleted_at IS NULL');
        
        const stats = {
            total_karyawan: results[0]?.total || 0,
            belum_aktivasi: 0,
            hadir_hari_ini: 0
        };
        
        res.render('admin/dashboard', { 
            title: 'Dashboard - Fleur Atelier',
            admin: req.session.admin,
            stats: stats
        });
    } catch (err) {
        console.error('Dashboard error:', err);
        res.render('admin/dashboard', { 
            title: 'Dashboard - Fleur Atelier',
            admin: req.session.admin,
            stats: defaultStats
        });
    }
});

// API for presensi chart data
router.get('/api/attendance-chart-data', requireAuth, async (req, res) => {
    // Get presensi data for the last 7 days
    const query = `
        SELECT
            DATE(tanggal) as tanggal,
            COUNT(*) as jumlah_absensi
        FROM presensi
        WHERE tanggal >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
        GROUP BY DATE(tanggal)
        ORDER BY tanggal ASC
    `;
    
    db.query(query, (err, results) => {
        if (err) {
            console.error('Chart data error:', err);
            return res.json({ success: false, message: 'Gagal memuat data grafik' });
        }
        
        // Create labels and data arrays for the last 7 days
        const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Makassar' }));
        const labels = [];
        const data = [];
        const attendanceMap = {};
        
        // Map results by date
        results.forEach(row => {
            const dateStr = row.tanggal.toISOString().split('T')[0];
            attendanceMap[dateStr] = row.jumlah_absensi;
        });
        
        // Generate data for the last 7 days
        for (let i = 6; i >= 0; i--) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            const dateStr = getDateWITA(-i);
            
            labels.push(date.toLocaleDateString('id-ID', { 
                weekday: 'short', 
                day: 'numeric', 
                month: 'short' 
            }));
            
            data.push(attendanceMap[dateStr] || 0);
        }
        
        res.json({
            success: true,
            chartData: {
                labels: labels,
                data: data
            }
        });
    });
});

// Master Karyawan - List
router.get('/karyawan', requireAuth, async (req, res) => {
    const { page, limit, q } = getListParams(req, { defaultLimit: 10, maxLimit: 100 });
    const whereClauses = ['e.deleted_at IS NULL'];
    const queryParams = [];

    if (q) {
        whereClauses.push(`(
            e.nik LIKE ?
            OR e.nama LIKE ?
            OR COALESCE(e.email, '') LIKE ?
            OR COALESCE(e.phone, '') LIKE ?
            OR COALESCE(p.nama_jabatan, '') LIKE ?
        )`);
        const likeQ = `%${q}%`;
        queryParams.push(likeQ, likeQ, likeQ, likeQ, likeQ);
    }

    const whereSql = whereClauses.join(' AND ');
    const countQuery = `
        SELECT COUNT(*) AS total
        FROM karyawan e
        LEFT JOIN jabatan p ON e.id_jabatan = p.id
        WHERE ${whereSql}
    `;
    const listQuery = `
        SELECT
               e.id,
               e.nik,
               e.nama AS nama,
               e.email,
               e.phone,
               e.id_jabatan AS id_jabatan,
               e.id_jadwal_kerja,
               e.jenis_kelamin,
               DATE_FORMAT(e.tanggal_lahir, '%Y-%m-%d') AS tanggal_lahir,
               e.address,
               e.email_verified_at,
               p.nama_jabatan AS jabatan,
               ws.nama AS jadwal_kerja,
               s.nama_shift AS nama_shift,
               (e.status = 'active') AS is_activated,
               NULL AS foto_referensi,
               e.profile_picture AS profile_picture,
               e.created_at,
               (SELECT photo_path FROM karyawan_face_reference
                WHERE id_karyawan = e.id AND is_active = TRUE
                ORDER BY created_at DESC LIMIT 1) AS trained_photo
        FROM karyawan e
        LEFT JOIN jabatan p ON e.id_jabatan = p.id
        LEFT JOIN jadwal_kerja ws ON e.id_jadwal_kerja = ws.id
        LEFT JOIN shift s ON s.id = COALESCE(e.shift_id, ws.shift_id)
        WHERE ${whereSql}
        ORDER BY e.created_at DESC
    `;

    try {
        const countRows = await db.query(countQuery, queryParams);
        const totalItems = countRows[0]?.total || 0;
        const pagination = getPagination(totalItems, page, limit);
        const { safeLimit, safeOffset } = getSafeLimitOffset(pagination);
        const results = await db.query(`${listQuery} LIMIT ${safeLimit} OFFSET ${safeOffset}`, queryParams);

        res.render('admin/karyawan/index', {
            title: 'Master Karyawan - Fleur Atelier',
            admin: req.session.admin,
            karyawan: results,
            filters: { q },
            pagination,
            success: req.flash('success'),
            error: req.flash('error')
        });
    } catch (err) {
        console.error('Karyawan list error:', err);
        return res.render('admin/karyawan/index', {
            title: 'Master Karyawan - Fleur Atelier',
            admin: req.session.admin,
            karyawan: [],
            filters: { q },
            pagination: getPagination(0, 1, limit),
            success: req.flash('success'),
            error: req.flash('error')
        });
    }
});

// Master Karyawan - Add Form
router.get('/karyawan/add', requireAuth, async (req, res) => {
    // Get jabatan list
    const jabatanQuery = 'SELECT id, nama_jabatan, deskripsi FROM jabatan WHERE deleted_at IS NULL ORDER BY nama_jabatan';
    // Get work schedules
    const scheduleQuery = `
        SELECT ws.id, ws.nama AS nama, s.jam_masuk AS jam_masuk, s.jam_keluar AS jam_keluar
        FROM jadwal_kerja ws
        LEFT JOIN shift s ON s.id = ws.shift_id
        WHERE ws.is_active = TRUE AND ws.deleted_at IS NULL
        ORDER BY s.jam_masuk
    `;

    db.query(jabatanQuery, (err, jabatanResults) => {
        if (err) {
            console.error('Jabatan query error:', err);
            return res.render('admin/karyawan/add', { 
                title: 'Tambah Karyawan - Fleur Atelier',
                admin: req.session.admin,
                jabatan: [],
                schedules: [],
                error: req.flash('error')
            });
        }

        db.query(scheduleQuery, (err2, scheduleResults) => {
            if (err2) {
                console.error('Schedule query error:', err2);
                return res.render('admin/karyawan/add', { 
                    title: 'Tambah Karyawan - Fleur Atelier',
                    admin: req.session.admin,
                    jabatan: jabatanResults,
                    schedules: [],
                    error: req.flash('error')
                });
            }

            res.render('admin/karyawan/add', {
                title: 'Tambah Karyawan - Fleur Atelier',
                admin: req.session.admin,
                jabatan: jabatanResults,
                schedules: scheduleResults,
                error: req.flash('error')
            });
        });
    });
});

// Master Karyawan - Add Process
router.post('/karyawan/add', requireAuth, async (req, res) => {
    // Foto referensi dihapus dari form — enrollment wajah dilakukan karyawan
    // sendiri lewat app (5 pose). Form ini tidak lagi multipart, cukup req.body.
    const { nik, nama, email, phone, id_jabatan, id_jadwal_kerja, jenis_kelamin, tanggal_lahir, address } = req.body;

    if (!nik || !nama || !id_jabatan || !id_jadwal_kerja) {
        req.flash('error', 'Semua field harus diisi');
        return res.redirect('/admin/karyawan/add');
    }

    const query = `
        INSERT INTO karyawan (
            nik, nama, email, phone, id_jabatan, id_jadwal_kerja, jenis_kelamin, tanggal_lahir, address, status, face_enrollment_completed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', FALSE)
    `;

    db.query(query, [
        nik,
        nama,
        email || null,
        phone || null,
        id_jabatan,
        id_jadwal_kerja,
        jenis_kelamin || null,
        tanggal_lahir || null,
        address || null
    ], (err) => {
        if (err) {
            console.error('Database error:', err);
            if (err.code === 'ER_DUP_ENTRY') {
                req.flash('error', 'NIK sudah terdaftar');
            } else {
                req.flash('error', 'Gagal menambah karyawan: ' + err.message);
            }
            return res.redirect('/admin/karyawan/add');
        }

        req.flash('success', 'Karyawan berhasil ditambahkan');
        res.redirect('/admin/karyawan');
    });
});

// Master Karyawan - Delete
router.post('/karyawan/delete/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    
    const query = 'UPDATE karyawan SET deleted_at = NOW(), status = \'inactive\' WHERE id = ?';
    
    db.query(query, [id], (err, results) => {
        if (err) {
            req.flash('error', 'Gagal menghapus karyawan');
        } else {
            req.flash('success', 'Karyawan berhasil dihapus');
        }
        res.redirect('/admin/karyawan');
    });
});

// Master Karyawan - Update (API)
router.post('/karyawan/update', requireAuth, async (req, res) => {
    const { id, nik, nama, email, phone, id_jabatan, id_jadwal_kerja, jenis_kelamin, tanggal_lahir, address } = req.body;
    
    if (!id || !nik || !nama || !id_jabatan) {
        return res.json({ success: false, message: 'Semua field harus diisi' });
    }

    let query, params;
    query = `UPDATE karyawan SET nik = ?, nama = ?, email = ?, phone = ?, id_jabatan = ?, id_jadwal_kerja = ?,
             jenis_kelamin = ?, tanggal_lahir = ?, address = ? WHERE id = ? AND deleted_at IS NULL`;
    params = [nik.trim(), nama.trim(), email || null, phone || null, id_jabatan, id_jadwal_kerja || null,
              jenis_kelamin || null, tanggal_lahir || null, address || null, id];
    
    db.query(query, params, (err, results) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY') {
                return res.json({ success: false, message: 'NIK sudah terdaftar oleh karyawan lain' });
            }
            return res.json({ success: false, message: 'Gagal mengupdate karyawan' });
        }

        if (results.affectedRows === 0) {
            return res.json({ success: false, message: 'Karyawan tidak ditemukan' });
        }

        res.json({ success: true, message: 'Karyawan berhasil diupdate' });
    });
});

// Master Karyawan - Reset (API)
router.post('/karyawan/reset', requireAuth, async (req, res) => {
    const { id } = req.body;
    
    if (!id) {
        return res.json({ success: false, message: 'ID karyawan harus diisi' });
    }
    
    try {
        // Pastikan karyawan ada
        const karyawanRows = await db.query(
            'SELECT id, profile_picture FROM karyawan WHERE id = ? AND deleted_at IS NULL',
            [id]
        );

        if (!karyawanRows || karyawanRows.length === 0) {
            return res.json({ success: false, message: 'Karyawan tidak ditemukan' });
        }

        // === Kumpulkan SEMUA path foto milik karyawan ini ===
        const photoPaths = new Set();

        // 1) Foto profil
        if (karyawanRows[0].profile_picture) {
            photoPaths.add(karyawanRows[0].profile_picture);
        }

        // 2) Foto referensi wajah (enrollment)
        const faceRows = await db.query(
            'SELECT photo_path FROM karyawan_face_reference WHERE id_karyawan = ?',
            [id]
        );
        for (const row of faceRows) {
            if (row.photo_path) photoPaths.add(row.photo_path);
        }

        // 3) Foto absensi (check-in / check-out / SELESAI ISTIRAHAT) dari kolom JSON presensi
        const parsePresensiJson = (v) => { try { return typeof v === 'string' ? JSON.parse(v || '{}') : (v || {}); } catch (e) { return {}; } };
        const presensiRows = await db.query(
            'SELECT id, data_masuk, data_keluar FROM presensi WHERE id_karyawan = ?',
            [id]
        );
        const presensiClean = []; // record presensi setelah semua field foto dibuang
        for (const row of presensiRows) {
            const dm = parsePresensiJson(row.data_masuk);
            const dk = parsePresensiJson(row.data_keluar);
            if (dm && dm.foto) { photoPaths.add(dm.foto); dm.foto = null; }
            if (dk && dk.foto) { photoPaths.add(dk.foto); dk.foto = null; }
            // foto tiap sesi istirahat (nested di data_masuk.istirahat.sesi[])
            if (dm && dm.istirahat && Array.isArray(dm.istirahat.sesi)) {
                dm.istirahat.sesi.forEach((s) => { if (s && s.foto) { photoPaths.add(s.foto); s.foto = null; } });
            }
            presensiClean.push({
                id: row.id,
                dataMasuk: JSON.stringify(dm),
                dataKeluar: (row.data_keluar == null ? null : JSON.stringify(dk))
            });
        }

        // 4) Foto percobaan wajah GAGAL (kolom JSON karyawan.data_percobaan_gagal)
        try {
            const gagalRows = await db.query('SELECT data_percobaan_gagal FROM karyawan WHERE id = ?', [id]);
            let arr = (gagalRows && gagalRows[0]) ? gagalRows[0].data_percobaan_gagal : null;
            if (typeof arr === 'string') { try { arr = JSON.parse(arr || '[]'); } catch (e) { arr = []; } }
            if (Array.isArray(arr)) {
                for (const a of arr) { if (a && a.foto) photoPaths.add(a.foto); }
            }
        } catch (e) {
            console.warn('[RESET] lewati data_percobaan_gagal:', e.message);
        }

        // === Hapus semua file fisik / Blob ===
        let deletedCount = 0;
        for (const p of photoPaths) {
            try {
                const removed = await deleteStoredFile(p);
                if (removed) {
                    deletedCount++;
                } else {
                    console.log(`⚠️ File foto tidak ditemukan: ${p}`);
                }
            } catch (fileErr) {
                console.error(`❌ Gagal menghapus foto ${p}: ${fileErr.message}`);
            }
        }
        console.log(`🧹 Reset karyawan ${id}: ${deletedCount}/${photoPaths.size} file foto dihapus dari storage`);

        // === Bersihkan DB ===
        // Hapus baris referensi wajah (bukan sekadar nonaktif) supaya storage & DB benar-benar bersih
        await db.query('DELETE FROM karyawan_face_reference WHERE id_karyawan = ?', [id]);

        // Buang SEMUA field foto dari record presensi (check-in/out + tiap sesi istirahat).
        // Record absensi tetap ada, cuma fotonya hilang -> tidak muncul lagi di /admin/testing.
        for (const p of presensiClean) {
            await db.query('UPDATE presensi SET data_masuk = ?, data_keluar = ? WHERE id = ?', [p.dataMasuk, p.dataKeluar, p.id]);
        }

        // Reset data aktivasi karyawan (email, PIN, status, verifikasi email)
        await db.query(
            `UPDATE karyawan
             SET email = NULL,
                 status = 'draft',
                 profile_picture = NULL,
                 pin_hash = NULL,
                 face_enrollment_completed = FALSE,
                 data_percobaan_gagal = NULL,
                 email_verified_at = NULL,
                 email_verification_token = NULL,
                 email_verification_expires_at = NULL,
                 email_verification_sent_at = NULL
             WHERE id = ? AND deleted_at IS NULL`,
            [id]
        );

        res.json({
            success: true,
            message: `Karyawan berhasil direset. ${deletedCount} foto (referensi wajah, profil, absensi) dihapus dari storage. Email, PIN, dan referensi wajah dibersihkan untuk aktivasi ulang.`
        });
    } catch (err) {
        console.error('Error reset karyawan:', err);
        return res.json({ success: false, message: 'Gagal mereset karyawan: ' + err.message });
    }
});

// Laporan Presensi (juga di-mount di /presensi sebagai alias dengan sidebar context berbeda)
const laporanHandler = async (req, res) => {
    const isPresensiContext = req.path === '/presensi' || req.originalUrl.startsWith('/admin/presensi');
    let { tanggal, filterType, startDate, endDate, month, year } = req.query;
    // Default: bulan berjalan biar laporan langsung berisi data (hari ini sering kosong)
    if (!filterType && !tanggal && !startDate && !month && !year) {
        const now = new Date();
        filterType = 'month';
        month = String(now.getMonth() + 1);
        year = String(now.getFullYear());
    }
    let whereClause = '';
    let queryParams = [];
    
    // Build where clause based on filter type
    if (filterType === 'range' && startDate && endDate) {
        whereClause = 'WHERE DATE(p.tanggal) BETWEEN ? AND ?';
        queryParams.push(startDate, endDate);
    } else if (filterType === 'month' && month && year) {
        whereClause = 'WHERE MONTH(p.tanggal) = ? AND YEAR(p.tanggal) = ?';
        queryParams.push(month, year);
    } else if (filterType === 'year' && year) {
        whereClause = 'WHERE YEAR(p.tanggal) = ?';
        queryParams.push(year);
    } else if (tanggal) {
        whereClause = 'WHERE DATE(p.tanggal) = ?';
        queryParams.push(tanggal);
    } else {
        whereClause = 'WHERE DATE(p.tanggal) = CURDATE()';
    }
    
    const query = `
        SELECT 
            p.id,
            p.id_karyawan AS id_karyawan,
            k.nik,
            k.nama AS nama,
            k.profile_picture AS profile_picture,
            j.nama_jabatan AS jabatan,
            p.tanggal AS tanggal,
            TIME(p.jam_masuk) AS jam_masuk,
            TIME(p.jam_keluar) AS jam_keluar,
            (
                JSON_UNQUOTE(JSON_EXTRACT(p.data_masuk, '$.foto'))
            ) AS foto_masuk,
            (
                JSON_UNQUOTE(JSON_EXTRACT(p.data_keluar, '$.foto'))
            ) AS foto_keluar,
            (
                JSON_UNQUOTE(JSON_EXTRACT(p.data_masuk, '$.latitude'))
            ) AS lat_masuk,
            (
                JSON_UNQUOTE(JSON_EXTRACT(p.data_masuk, '$.longitude'))
            ) AS long_masuk,
            (
                JSON_UNQUOTE(JSON_EXTRACT(p.data_keluar, '$.latitude'))
            ) AS lat_keluar,
            (
                JSON_UNQUOTE(JSON_EXTRACT(p.data_keluar, '$.longitude'))
            ) AS long_keluar,
            p.status AS status,
            (
                JSON_UNQUOTE(JSON_EXTRACT(p.data_masuk, '$.face_similarity'))
            ) AS face_similarity_in,
            (
                JSON_UNQUOTE(JSON_EXTRACT(p.data_keluar, '$.face_similarity'))
            ) AS face_similarity_out,
            (
                JSON_UNQUOTE(JSON_EXTRACT(p.data_masuk, '$.jarak_meter'))
            ) AS distance_in,
            (
                JSON_UNQUOTE(JSON_EXTRACT(p.data_keluar, '$.jarak_meter'))
            ) AS distance_out
        FROM presensi p
        JOIN karyawan k ON p.id_karyawan = k.id
        LEFT JOIN jabatan j ON k.id_jabatan = j.id
        ${whereClause}
        ORDER BY p.tanggal DESC, p.jam_masuk DESC
    `;
    
    // Also get office settings for map
    const settingQuery = 'SELECT lat_kantor AS lat_kantor, long_kantor AS long_kantor, radius_meter FROM pengaturan LIMIT 1';
    
    db.query(query, queryParams, (err, presensiResults) => {
        if (err) {
            console.error('Laporan error:', err);
            return res.render('admin/laporan', {
                title: isPresensiContext ? 'Daftar Presensi - Fleur Atelier' : 'Laporan Presensi - Fleur Atelier',
                admin: req.session.admin,
                presensi: [],
                filter: { tanggal: tanggal || getCurrentDateWITA(), filterType, startDate, endDate, month, year },
                officeSetting: { lat_kantor: -8.8155675, long_kantor: 115.1253343, radius_meter: 100 },
                GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || '',
                currentPage: isPresensiContext ? 'presensi' : 'laporan'
            });
        }

        db.query(settingQuery, (settingErr, settingResults) => {
            const officeSetting = settingResults && settingResults.length > 0
                ? settingResults[0]
                : { lat_kantor: -8.8155675, long_kantor: 115.1253343, radius_meter: 100 };

            res.render('admin/laporan', {
                title: isPresensiContext ? 'Daftar Presensi - Fleur Atelier' : 'Laporan Presensi - Fleur Atelier',
                admin: req.session.admin,
                presensi: presensiResults,
                filter: { tanggal: tanggal || getCurrentDateWITA(), filterType, startDate, endDate, month, year },
                officeSetting: officeSetting,
                GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || '',
                currentPage: isPresensiContext ? 'presensi' : 'laporan'
            });
        });
    });
};
// /admin/presensi → halaman Daftar Presensi (list karyawan + ringkasan presensi periode)
router.get('/presensi', requireAuth, async (req, res) => {
    const { page, limit, q } = getListParams(req, { defaultLimit: 10, maxLimit: 100 });
    const { tanggal, filterType, startDate, endDate, month, year } = req.query;

    // Build presensi date filter (sub-query)
    let presensiFilter = '';
    let presensiParams = [];
    let periodLabel = '';

    if (filterType === 'range' && startDate && endDate) {
        presensiFilter = 'AND DATE(p.tanggal) BETWEEN ? AND ?';
        presensiParams = [startDate, endDate];
        periodLabel = `${startDate} s/d ${endDate}`;
    } else if (filterType === 'month' && month && year) {
        presensiFilter = 'AND MONTH(p.tanggal) = ? AND YEAR(p.tanggal) = ?';
        presensiParams = [month, year];
        const monthNames = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
        periodLabel = `${monthNames[Number(month)] || month} ${year}`;
    } else if (filterType === 'year' && year) {
        presensiFilter = 'AND YEAR(p.tanggal) = ?';
        presensiParams = [year];
        periodLabel = `Tahun ${year}`;
    } else if (filterType === 'date' && tanggal) {
        presensiFilter = 'AND DATE(p.tanggal) = ?';
        presensiParams = [tanggal];
        periodLabel = tanggal;
    } else {
        // Default: bulan berjalan
        const today = new Date();
        const m = today.getMonth() + 1;
        const y = today.getFullYear();
        presensiFilter = 'AND MONTH(p.tanggal) = ? AND YEAR(p.tanggal) = ?';
        presensiParams = [m, y];
        const monthNames = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
        periodLabel = `${monthNames[m]} ${y} (default)`;
    }

    // Search filter
    const whereClauses = ['e.deleted_at IS NULL'];
    const whereParams = [];
    if (q) {
        whereClauses.push(`(e.nama LIKE ? OR e.nik LIKE ? OR COALESCE(j.nama_jabatan,'') LIKE ?)`);
        const likeQ = `%${q}%`;
        whereParams.push(likeQ, likeQ, likeQ);
    }
    const whereSql = whereClauses.join(' AND ');

    try {
        // Count total karyawan
        const countRows = await db.query(`
            SELECT COUNT(*) AS total
            FROM karyawan e
            LEFT JOIN jabatan j ON e.id_jabatan = j.id
            WHERE ${whereSql}
        `, whereParams);
        const totalItems = countRows[0]?.total || 0;
        const pagination = getPagination(totalItems, page, limit);
        const { safeLimit, safeOffset } = getSafeLimitOffset(pagination);

        // List karyawan + summary presensi
        const sql = `
            SELECT
                e.id,
                e.nik,
                e.nama,
                j.nama_jabatan,
                jk.nama AS jadwal_kerja,
                s.nama_shift,
                COALESCE(ps.total_hadir, 0) AS total_hadir,
                COALESCE(ps.total_terlambat, 0) AS total_terlambat,
                COALESCE(ps.total_presensi, 0) AS total_presensi
            FROM karyawan e
            LEFT JOIN jabatan j ON e.id_jabatan = j.id
            LEFT JOIN jadwal_kerja jk ON e.id_jadwal_kerja = jk.id
            LEFT JOIN shift s ON s.id = COALESCE(e.shift_id, jk.shift_id)
            LEFT JOIN (
                SELECT
                    p.id_karyawan,
                    COUNT(*) AS total_presensi,
                    SUM(CASE WHEN LOWER(p.status) IN ('hadir','present') THEN 1 ELSE 0 END) AS total_hadir,
                    SUM(CASE WHEN LOWER(p.status) = 'late' THEN 1 ELSE 0 END) AS total_terlambat
                FROM presensi p
                WHERE 1=1 ${presensiFilter}
                GROUP BY p.id_karyawan
            ) ps ON ps.id_karyawan = e.id
            WHERE ${whereSql}
            ORDER BY e.nama ASC
            LIMIT ${safeLimit} OFFSET ${safeOffset}
        `;

        const employees = await db.query(sql, [...presensiParams, ...whereParams]);

        // Calculate "belum presensi" (working days dalam periode - total_hadir - total_terlambat)
        // Simplification: tampilkan saja sebagai placeholder count yang dihitung di client based on data presensi
        // Untuk sekarang, set belum_presensi = 0 (full implementation butuh kalkulasi working days)
        employees.forEach(emp => {
            emp.belum_presensi = 0; // Placeholder; bisa di-improve kalau perlu
        });

        res.render('admin/presensi/index', {
            title: 'Daftar Presensi - Fleur Atelier',
            admin: req.session.admin,
            employees,
            filters: { q, filterType, tanggal, startDate, endDate, month, year },
            periodLabel,
            pagination
        });
    } catch (err) {
        console.error('Presensi list error:', err);
        res.render('admin/presensi/index', {
            title: 'Daftar Presensi - Fleur Atelier',
            admin: req.session.admin,
            employees: [],
            filters: { q, filterType, tanggal, startDate, endDate, month, year },
            periodLabel: '-',
            pagination: getPagination(0, 1, limit)
        });
    }
});

// /admin/presensi/karyawan/:id → halaman detail riwayat presensi karyawan
// Export Excel: Daftar Presensi (ringkasan per karyawan)
router.get('/presensi/export', requireAuth, async (req, res) => {
    try {
        const { q, tanggal, filterType, startDate, endDate, month, year } = req.query;
        const monthNames = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
        let presensiFilter = '';
        let presensiParams = [];
        let periodLabel = '';
        if (filterType === 'range' && startDate && endDate) {
            presensiFilter = 'AND DATE(p.tanggal) BETWEEN ? AND ?'; presensiParams = [startDate, endDate]; periodLabel = `${startDate} s/d ${endDate}`;
        } else if (filterType === 'month' && month && year) {
            presensiFilter = 'AND MONTH(p.tanggal) = ? AND YEAR(p.tanggal) = ?'; presensiParams = [month, year]; periodLabel = `${monthNames[Number(month)] || month} ${year}`;
        } else if (filterType === 'year' && year) {
            presensiFilter = 'AND YEAR(p.tanggal) = ?'; presensiParams = [year]; periodLabel = `Tahun ${year}`;
        } else if (filterType === 'date' && tanggal) {
            presensiFilter = 'AND DATE(p.tanggal) = ?'; presensiParams = [tanggal]; periodLabel = tanggal;
        } else {
            const today = new Date(); const m = today.getMonth() + 1; const y = today.getFullYear();
            presensiFilter = 'AND MONTH(p.tanggal) = ? AND YEAR(p.tanggal) = ?'; presensiParams = [m, y]; periodLabel = `${monthNames[m]} ${y}`;
        }
        const whereClauses = ['e.deleted_at IS NULL'];
        const whereParams = [];
        if (q) { whereClauses.push(`(e.nama LIKE ? OR e.nik LIKE ? OR COALESCE(j.nama_jabatan,'') LIKE ?)`); const likeQ = `%${q}%`; whereParams.push(likeQ, likeQ, likeQ); }
        const whereSql = whereClauses.join(' AND ');

        const rows = await db.query(`
            SELECT e.nik, e.nama, j.nama_jabatan, jk.nama AS jadwal_kerja, s.nama_shift,
                   COALESCE(ps.total_hadir,0) AS total_hadir, COALESCE(ps.total_terlambat,0) AS total_terlambat, COALESCE(ps.total_presensi,0) AS total_presensi
            FROM karyawan e
            LEFT JOIN jabatan j ON e.id_jabatan = j.id
            LEFT JOIN jadwal_kerja jk ON e.id_jadwal_kerja = jk.id
            LEFT JOIN shift s ON s.id = COALESCE(e.shift_id, jk.shift_id)
            LEFT JOIN (
                SELECT p.id_karyawan, COUNT(*) AS total_presensi,
                       SUM(CASE WHEN LOWER(p.status) IN ('hadir','present') THEN 1 ELSE 0 END) AS total_hadir,
                       SUM(CASE WHEN LOWER(p.status) = 'late' THEN 1 ELSE 0 END) AS total_terlambat
                FROM presensi p WHERE 1=1 ${presensiFilter} GROUP BY p.id_karyawan
            ) ps ON ps.id_karyawan = e.id
            WHERE ${whereSql}
            ORDER BY e.nama ASC
        `, [...presensiParams, ...whereParams]);

        const columns = [
            { key: 'no', header: 'No', width: 5, align: 'center' },
            { key: 'nik', header: 'NIK', width: 20 },
            { key: 'nama', header: 'Nama', width: 26 },
            { key: 'jabatan', header: 'Jabatan', width: 20 },
            { key: 'shift', header: 'Jadwal / Shift', width: 26 },
            { key: 'total_hadir', header: 'Total Hadir', width: 12, align: 'center' },
            { key: 'total_terlambat', header: 'Total Terlambat', width: 14, align: 'center' },
            { key: 'total_presensi', header: 'Total Presensi', width: 14, align: 'center' }
        ];
        const data = rows.map((r, i) => ({
            no: i + 1, nik: r.nik, nama: r.nama, jabatan: r.nama_jabatan || '-',
            shift: [r.jadwal_kerja, r.nama_shift].filter(Boolean).join(' / ') || '-',
            total_hadir: r.total_hadir, total_terlambat: r.total_terlambat, total_presensi: r.total_presensi
        }));
        const { generateSimpleExcel } = require('../utils/excel-export');
        const buffer = await generateSimpleExcel({ title: 'Daftar Presensi Karyawan', periodLabel: `Periode: ${periodLabel}`, columns, rows: data });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="Daftar_Presensi.xlsx"');
        res.send(buffer);
    } catch (err) {
        console.error('Export presensi error:', err);
        req.flash('error', 'Gagal mengekspor daftar presensi');
        res.redirect('/admin/presensi');
    }
});

router.get('/presensi/karyawan/:id', requireAuth, async (req, res) => {
    const employeeId = req.params.id;
    const { page, limit } = getListParams(req, { defaultLimit: 15, maxLimit: 100 });
    const { tanggal, filterType, startDate, endDate, month, year } = req.query;

    // Build presensi date filter
    let presensiFilter = '';
    let presensiParams = [employeeId];
    let periodLabel = '';
    const ft = filterType || 'month';

    if (ft === 'range' && startDate && endDate) {
        presensiFilter = 'AND DATE(p.tanggal) BETWEEN ? AND ?';
        presensiParams.push(startDate, endDate);
        periodLabel = `${startDate} s/d ${endDate}`;
    } else if (ft === 'month' && month && year) {
        presensiFilter = 'AND MONTH(p.tanggal) = ? AND YEAR(p.tanggal) = ?';
        presensiParams.push(month, year);
        const monthNames = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
        periodLabel = `${monthNames[Number(month)] || month} ${year}`;
    } else if (ft === 'year' && year) {
        presensiFilter = 'AND YEAR(p.tanggal) = ?';
        presensiParams.push(year);
        periodLabel = `Tahun ${year}`;
    } else if (ft === 'date' && tanggal) {
        presensiFilter = 'AND DATE(p.tanggal) = ?';
        presensiParams.push(tanggal);
        periodLabel = tanggal;
    } else {
        // Default: bulan berjalan
        const today = new Date();
        const m = today.getMonth() + 1;
        const y = today.getFullYear();
        presensiFilter = 'AND MONTH(p.tanggal) = ? AND YEAR(p.tanggal) = ?';
        presensiParams.push(m, y);
        const monthNames = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
        periodLabel = `${monthNames[m]} ${y} (default)`;
    }

    try {
        // Get employee info
        const empRows = await db.query(`
            SELECT e.id, e.nik, e.nama, e.email, e.profile_picture,
                   j.nama_jabatan, jk.nama AS jadwal_kerja, s.nama_shift
            FROM karyawan e
            LEFT JOIN jabatan j ON e.id_jabatan = j.id
            LEFT JOIN jadwal_kerja jk ON e.id_jadwal_kerja = jk.id
            LEFT JOIN shift s ON s.id = COALESCE(e.shift_id, jk.shift_id)
            WHERE e.id = ? AND e.deleted_at IS NULL
            LIMIT 1
        `, [employeeId]);

        if (!empRows || empRows.length === 0) {
            req.flash('error', 'Karyawan tidak ditemukan');
            return res.redirect('/admin/presensi');
        }
        const employee = empRows[0];

        // Summary
        const summaryRows = await db.query(`
            SELECT
                COUNT(*) AS total_presensi,
                SUM(CASE WHEN LOWER(p.status) IN ('hadir','present') THEN 1 ELSE 0 END) AS total_hadir,
                SUM(CASE WHEN LOWER(p.status) = 'late' THEN 1 ELSE 0 END) AS total_terlambat,
                SUM(CASE WHEN LOWER(p.status) NOT IN ('hadir','present','late') THEN 1 ELSE 0 END) AS total_tidak_hadir
            FROM presensi p
            WHERE p.id_karyawan = ? ${presensiFilter}
        `, presensiParams);
        const summary = summaryRows[0] || {};

        // Count untuk pagination
        const countRecRows = await db.query(`
            SELECT COUNT(*) AS total
            FROM presensi p
            WHERE p.id_karyawan = ? ${presensiFilter}
        `, presensiParams);
        const totalRec = countRecRows[0]?.total || 0;
        const pagination = getPagination(totalRec, page, limit);
        const { safeLimit, safeOffset } = getSafeLimitOffset(pagination);

        // Riwayat detail (paginated)
        const records = await db.query(`
            SELECT
                p.id, p.tanggal,
                TIME(p.jam_masuk) AS jam_masuk,
                TIME(p.jam_keluar) AS jam_keluar,
                p.status,
                p.total_work_minutes,
                p.effective_work_minutes,
                p.approved_leave_minutes,
                p.late_minutes,
                p.early_leave_minutes,
                p.overtime_minutes,
                JSON_UNQUOTE(JSON_EXTRACT(p.data_masuk, '$.latitude')) AS lat_masuk,
                JSON_UNQUOTE(JSON_EXTRACT(p.data_masuk, '$.longitude')) AS long_masuk,
                JSON_UNQUOTE(JSON_EXTRACT(p.data_masuk, '$.jarak_meter')) AS distance_in,
                JSON_UNQUOTE(JSON_EXTRACT(p.data_keluar, '$.latitude')) AS lat_keluar,
                JSON_UNQUOTE(JSON_EXTRACT(p.data_keluar, '$.longitude')) AS long_keluar,
                JSON_UNQUOTE(JSON_EXTRACT(p.data_keluar, '$.jarak_meter')) AS distance_out,
                JSON_UNQUOTE(JSON_EXTRACT(p.data_masuk, '$.istirahat.dihitung_menit')) AS break_minutes,
                JSON_UNQUOTE(JSON_EXTRACT(p.data_masuk, '$.face_similarity')) AS sim_in,
                JSON_UNQUOTE(JSON_EXTRACT(p.data_keluar, '$.face_similarity')) AS sim_out,
                mg.m_nama AS menggantikan,
                mg.m_nik AS mg_nik,
                mg.m_tipe AS mg_tipe,
                mg.m_jam_mulai AS mg_jam_mulai,
                mg.m_jam_selesai AS mg_jam_selesai
            FROM presensi p
            LEFT JOIN LATERAL (
                SELECT ka.nama AS m_nama, ka.nik AS m_nik, a.leave_type AS m_tipe,
                       TIME(a.jam_mulai) AS m_jam_mulai, TIME(a.jam_selesai) AS m_jam_selesai
                FROM permintaan_absensi pa
                JOIN absensi a ON a.id = pa.id_absensi
                JOIN karyawan ka ON ka.id = a.id_karyawan
                WHERE pa.id_pengganti = p.id_karyawan
                  AND pa.status = 'disetujui'
                  AND a.status = 'disetujui'
                  AND (
                    (a.leave_type = 'urgent' AND p.tanggal = a.tanggal_mulai)
                    OR (a.leave_type <> 'urgent' AND p.tanggal BETWEEN a.tanggal_mulai AND a.tanggal_selesai)
                  )
                LIMIT 1
            ) mg ON TRUE
            WHERE p.id_karyawan = ? ${presensiFilter}
            ORDER BY p.tanggal DESC, p.jam_masuk DESC
            LIMIT ${safeLimit} OFFSET ${safeOffset}
        `, presensiParams);

        // Fetch office setting (lokasi kantor)
        const officeRows = await db.query(`
            SELECT lat_kantor, long_kantor, radius_meter
            FROM pengaturan
            ORDER BY id ASC LIMIT 1
        `);
        const officeSetting = officeRows && officeRows.length > 0
            ? officeRows[0]
            : { lat_kantor: null, long_kantor: null, radius_meter: 100 };

        res.render('admin/presensi/karyawan-detail', {
            title: `Detail Presensi: ${employee.nama} - Fleur Atelier`,
            admin: req.session.admin,
            employee,
            summary,
            records,
            filters: { filterType: ft, tanggal, startDate, endDate, month, year },
            periodLabel,
            pagination,
            officeSetting
        });
    } catch (err) {
        console.error('Detail presensi karyawan error:', err);
        req.flash('error', 'Gagal memuat detail presensi');
        res.redirect('/admin/presensi');
    }
});

// Helper untuk build query string pagination presensi-detail


// /admin/laporan → halaman Laporan dengan 2 tab (Laporan Presensi + Laporan Absensi)
router.get('/laporan', requireAuth, async (req, res) => {
    let { tanggal, filterType, startDate, endDate, month, year } = req.query;
    // Default: minggu berjalan (Senin-Minggu) biar laporan langsung berisi data
    if (!filterType && !tanggal && !startDate && !month && !year) {
        filterType = 'week';
    }
    // Batas minggu berjalan (berbasis tanggal WITA)
    const _wt = new Date(getCurrentDateWITA() + 'T00:00:00Z');
    const _dow = (_wt.getUTCDay() + 6) % 7; // Senin = 0
    const _mon = new Date(_wt); _mon.setUTCDate(_wt.getUTCDate() - _dow);
    const _sun = new Date(_mon); _sun.setUTCDate(_mon.getUTCDate() + 6);
    const weekStart = _mon.toISOString().slice(0, 10);
    const weekEnd = _sun.toISOString().slice(0, 10);
    // Pagination per-tab via query param pp (presensi page) dan ap (absensi page)
    const presensiPage = Math.max(1, Number.parseInt(req.query.pp, 10) || 1);
    const absensiPage = Math.max(1, Number.parseInt(req.query.ap, 10) || 1);
    const pageLimit = 15;

    // Build WHERE clause for presensi
    let presensiWhere = '';
    let presensiParams = [];
    let absensiWhere = '';
    let absensiParams = [];

    if (filterType === 'week') {
        presensiWhere = 'WHERE DATE(p.tanggal) BETWEEN ? AND ?';
        presensiParams = [weekStart, weekEnd];
        absensiWhere = 'WHERE (DATE(lr.tanggal_mulai) BETWEEN ? AND ? OR DATE(lr.tanggal_selesai) BETWEEN ? AND ?)';
        absensiParams = [weekStart, weekEnd, weekStart, weekEnd];
    } else if (filterType === 'range' && startDate && endDate) {
        presensiWhere = 'WHERE DATE(p.tanggal) BETWEEN ? AND ?';
        presensiParams = [startDate, endDate];
        absensiWhere = 'WHERE DATE(lr.tanggal_mulai) BETWEEN ? AND ? OR DATE(lr.tanggal_selesai) BETWEEN ? AND ?';
        absensiParams = [startDate, endDate, startDate, endDate];
    } else if (filterType === 'month' && month && year) {
        presensiWhere = 'WHERE MONTH(p.tanggal) = ? AND YEAR(p.tanggal) = ?';
        presensiParams = [month, year];
        absensiWhere = 'WHERE (MONTH(lr.tanggal_mulai) = ? AND YEAR(lr.tanggal_mulai) = ?)';
        absensiParams = [month, year];
    } else if (filterType === 'year' && year) {
        presensiWhere = 'WHERE YEAR(p.tanggal) = ?';
        presensiParams = [year];
        absensiWhere = 'WHERE YEAR(lr.tanggal_mulai) = ?';
        absensiParams = [year];
    } else if (tanggal) {
        presensiWhere = 'WHERE DATE(p.tanggal) = ?';
        presensiParams = [tanggal];
        absensiWhere = 'WHERE DATE(lr.tanggal_mulai) <= ? AND DATE(lr.tanggal_selesai) >= ?';
        absensiParams = [tanggal, tanggal];
    } else {
        presensiWhere = 'WHERE DATE(p.tanggal) = CURDATE()';
        absensiWhere = 'WHERE DATE(lr.tanggal_mulai) <= CURDATE() AND DATE(lr.tanggal_selesai) >= CURDATE()';
    }

    try {
        // Counts untuk pagination
        const countPresensiRows = await db.query(`
            SELECT COUNT(*) AS total FROM presensi p ${presensiWhere}
        `, presensiParams);
        const totalPresensi = countPresensiRows[0]?.total || 0;
        const paginationP = getPagination(totalPresensi, presensiPage, pageLimit);
        const offsetP = (paginationP.page - 1) * pageLimit;

        const countAbsensiRows = await db.query(`
            SELECT COUNT(*) AS total FROM absensi lr ${absensiWhere}
        `, absensiParams);
        const totalAbsensi = countAbsensiRows[0]?.total || 0;
        const paginationA = getPagination(totalAbsensi, absensiPage, pageLimit);
        const offsetA = (paginationA.page - 1) * pageLimit;

        const presensiData = await db.query(`
            SELECT p.id, k.nama, j.nama_jabatan AS jabatan, p.tanggal,
                   TIME(p.jam_masuk) AS jam_masuk, TIME(p.jam_keluar) AS jam_keluar,
                   p.status
            FROM presensi p
            JOIN karyawan k ON p.id_karyawan = k.id
            LEFT JOIN jabatan j ON k.id_jabatan = j.id
            ${presensiWhere}
            ORDER BY p.tanggal DESC, p.jam_masuk DESC
            LIMIT ${pageLimit} OFFSET ${offsetP}
        `, presensiParams);

        const absensiData = await db.query(`
            SELECT lr.id, lr.jenis, lr.kategori, lr.tanggal_mulai, lr.tanggal_selesai,
                   lr.status, lr.created_at, lr.approved_at,
                   k.nama AS nama_karyawan, k.nik,
                   CASE
                       WHEN lr.status IN ('approved','rejected','disetujui','ditolak') THEN 'Manager'
                       ELSE '-'
                   END AS nama_approver
            FROM absensi lr
            JOIN karyawan k ON lr.id_karyawan = k.id
            ${absensiWhere}
            ORDER BY lr.created_at DESC
            LIMIT ${pageLimit} OFFSET ${offsetA}
        `, absensiParams);

        res.render('admin/laporan-rekap', {
            title: 'Laporan - Fleur Atelier',
            admin: req.session.admin,
            presensi: presensiData || [],
            absensi: absensiData || [],
            paginationPresensi: paginationP,
            paginationAbsensi: paginationA,
            filter: { tanggal: tanggal || getCurrentDateWITA(), filterType, startDate, endDate, month, year }
        });
    } catch (err) {
        console.error('Laporan rekap error:', err);
        const empty = getPagination(0, 1, pageLimit);
        res.render('admin/laporan-rekap', {
            title: 'Laporan - Fleur Atelier',
            admin: req.session.admin,
            presensi: [],
            absensi: [],
            paginationPresensi: empty,
            paginationAbsensi: empty,
            filter: { tanggal: tanggal || getCurrentDateWITA(), filterType, startDate, endDate, month, year }
        });
    }
});

// Export Laporan Presensi ke Excel (khusus admin; manager read-only tanpa ekspor)
router.get('/laporan/export', requireAuth, async (req, res) => {
    let { tanggal, filterType, startDate, endDate, month, year } = req.query;
    if (!filterType && !tanggal && !startDate && !month && !year) {
        filterType = 'week';
    }
    // Batas minggu berjalan (berbasis tanggal WITA)
    const _wt = new Date(getCurrentDateWITA() + 'T00:00:00Z');
    const _dow = (_wt.getUTCDay() + 6) % 7;
    const _mon = new Date(_wt); _mon.setUTCDate(_wt.getUTCDate() - _dow);
    const _sun = new Date(_mon); _sun.setUTCDate(_mon.getUTCDate() + 6);
    const weekStart = _mon.toISOString().slice(0, 10);
    const weekEnd = _sun.toISOString().slice(0, 10);
    let whereClause = '';
    let queryParams = [];
    let filterInfo = {};

    // Build where clause based on filter type
    if (filterType === 'week') {
        whereClause = 'WHERE DATE(p.tanggal) BETWEEN ? AND ?';
        queryParams.push(weekStart, weekEnd);
        filterInfo = { type: 'range', startDate: weekStart, endDate: weekEnd };
    } else if (filterType === 'range' && startDate && endDate) {
        whereClause = 'WHERE DATE(p.tanggal) BETWEEN ? AND ?';
        queryParams.push(startDate, endDate);
        filterInfo = { type: 'range', startDate, endDate };
    } else if (filterType === 'month' && month && year) {
        whereClause = 'WHERE MONTH(p.tanggal) = ? AND YEAR(p.tanggal) = ?';
        queryParams.push(month, year);
        filterInfo = { type: 'month', month, year };
    } else if (filterType === 'year' && year) {
        whereClause = 'WHERE YEAR(p.tanggal) = ?';
        queryParams.push(year);
        filterInfo = { type: 'year', year };
    } else if (tanggal) {
        whereClause = 'WHERE DATE(p.tanggal) = ?';
        queryParams.push(tanggal);
        filterInfo = { type: 'date', startDate: tanggal };
    } else {
        const today = getCurrentDateWITA();
        whereClause = 'WHERE DATE(p.tanggal) = ?';
        queryParams.push(today);
        filterInfo = { type: 'date', startDate: today };
    }
    
    const query = `
        SELECT 
            p.id,
            p.id_karyawan AS id_karyawan,
            k.nik,
            k.nama AS nama,
            j.nama_jabatan AS jabatan,
            p.tanggal AS tanggal,
            TIME(p.jam_masuk) AS jam_masuk,
            TIME(p.jam_keluar) AS jam_keluar,
            (
                JSON_UNQUOTE(JSON_EXTRACT(p.data_masuk, '$.foto'))
            ) AS foto_masuk,
            (
                JSON_UNQUOTE(JSON_EXTRACT(p.data_keluar, '$.foto'))
            ) AS foto_keluar,
            (
                JSON_UNQUOTE(JSON_EXTRACT(p.data_masuk, '$.latitude'))
            ) AS lat_masuk,
            (
                JSON_UNQUOTE(JSON_EXTRACT(p.data_masuk, '$.longitude'))
            ) AS long_masuk,
            (
                JSON_UNQUOTE(JSON_EXTRACT(p.data_keluar, '$.latitude'))
            ) AS lat_keluar,
            (
                JSON_UNQUOTE(JSON_EXTRACT(p.data_keluar, '$.longitude'))
            ) AS long_keluar,
            p.status AS status,
            (
                JSON_UNQUOTE(JSON_EXTRACT(p.data_masuk, '$.face_similarity'))
            ) AS face_similarity_in,
            (
                JSON_UNQUOTE(JSON_EXTRACT(p.data_keluar, '$.face_similarity'))
            ) AS face_similarity_out,
            (
                JSON_UNQUOTE(JSON_EXTRACT(p.data_masuk, '$.jarak_meter'))
            ) AS distance_in,
            (
                JSON_UNQUOTE(JSON_EXTRACT(p.data_keluar, '$.jarak_meter'))
            ) AS distance_out
        FROM presensi p
        JOIN karyawan k ON p.id_karyawan = k.id
        LEFT JOIN jabatan j ON k.id_jabatan = j.id
        ${whereClause}
        ORDER BY k.nama, p.tanggal, p.jam_masuk
    `;
    
    const settingQuery = 'SELECT lat_kantor AS lat_kantor, long_kantor AS long_kantor, radius_meter FROM pengaturan LIMIT 1';
    
    try {
        db.query(query, queryParams, async (err, presensiResults) => {
            if (err) {
                console.error('Export error:', err);
                req.flash('error', 'Gagal mengekspor data');
                return res.redirect('/admin/laporan');
            }

            db.query(settingQuery, async (settingErr, settingResults) => {
                const officeSetting = settingResults && settingResults.length > 0 
                    ? settingResults[0] 
                    : { lat_kantor: -8.8155675, long_kantor: 115.1253343, radius_meter: 100 };

                try {
                    const { generateAttendanceExcel } = require('../utils/excel-export');
                    const buffer = await generateAttendanceExcel(presensiResults, filterInfo, officeSetting);
                    
                    // Generate filename
                    let filename = 'Laporan_Presensi_';
                    if (filterInfo.type === 'range') {
                        filename += `${filterInfo.startDate}_${filterInfo.endDate}`;
                    } else if (filterInfo.type === 'month') {
                        filename += `${filterInfo.month}_${filterInfo.year}`;
                    } else if (filterInfo.type === 'year') {
                        filename += filterInfo.year;
                    } else {
                        filename += filterInfo.startDate;
                    }
                    filename += '.xlsx';
                    
                    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
                    res.send(buffer);
                } catch (excelErr) {
                    console.error('Excel generation error:', excelErr);
                    req.flash('error', 'Gagal membuat file Excel');
                    res.redirect('/admin/laporan');
                }
            });
        });
    } catch (error) {
        console.error('Export error:', error);
        req.flash('error', 'Gagal mengekspor data');
        res.redirect('/admin/laporan');
    }
});

// Setting Lokasi
router.get('/setting/database', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        const files = await listUploadFiles();
        res.render('admin/setting-database', {
            title: 'Setting Database & File Upload - Fleur Atelier',
            admin: req.session.admin,
            files,
            stats: getUploadStats(files),
            success: req.flash('success'),
            error: req.flash('error')
        });
    } catch (error) {
        console.error('Upload cleanup list error:', error);
        req.flash('error', 'Gagal membaca folder upload');
        res.redirect('/admin/setting');
    }
});

router.post('/setting/database/delete-file', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        const deletedName = await deleteUploadFileById(req.body.fileId);
        req.flash('success', `File ${deletedName} berhasil dihapus`);
    } catch (error) {
        console.error('Upload cleanup delete error:', error);
        req.flash('error', 'Gagal menghapus file upload');
    }

    res.redirect('/admin/setting/database');
});

router.post('/setting/database/delete-selected', requireAuth, requireSuperAdmin, async (req, res) => {
    const fileIds = normalizeFileIds(req.body.fileIds);
    if (fileIds.length === 0) {
        req.flash('error', 'Pilih minimal satu file untuk dihapus');
        return res.redirect('/admin/setting/database');
    }

    const result = await deleteUploadFilesByIds(fileIds);
    if (result.deleted.length > 0) {
        req.flash('success', `${result.deleted.length} file berhasil dihapus`);
    }
    if (result.errors.length > 0) {
        req.flash('error', `${result.errors.length} file gagal dihapus`);
    }

    res.redirect('/admin/setting/database');
});

router.post('/setting/database/delete-all', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        const files = await listUploadFiles();
        if (files.length === 0) {
            req.flash('error', 'Tidak ada file upload untuk dihapus');
            return res.redirect('/admin/setting/database');
        }

        const result = await deleteUploadFilesByIds(files.map(file => file.id));
        if (result.deleted.length > 0) {
            req.flash('success', `${result.deleted.length} file upload berhasil dihapus`);
        }
        if (result.errors.length > 0) {
            req.flash('error', `${result.errors.length} file gagal dihapus`);
        }
    } catch (error) {
        console.error('Upload cleanup delete all error:', error);
        req.flash('error', 'Gagal menghapus semua file upload');
    }

    res.redirect('/admin/setting/database');
});

router.get('/setting', requireAuth, async (req, res) => {
    const query = `
        SELECT
            lat_kantor AS lat_kantor,
            long_kantor AS long_kantor,
            radius_meter,
            durasi_istirahat_menit
        FROM pengaturan
        LIMIT 1
    `;

    db.query(query, (err, results) => {
        if (err) {
            console.error('Setting error:', err);
            return res.render('admin/setting', {
                title: 'Setting Lokasi - Fleur Atelier',
                admin: req.session.admin,
                setting: { lat_kantor: -8.8155675, long_kantor: 115.1253343, radius_meter: 100, durasi_istirahat_menit: 60 },
                success: req.flash('success'),
                error: req.flash('error')
            });
        }

        const setting = results.length > 0 ? results[0] : { lat_kantor: -8.8155675, long_kantor: 115.1253343, radius_meter: 100, durasi_istirahat_menit: 60 };

        res.render('admin/setting', {
            title: 'Setting Lokasi - Fleur Atelier',
            admin: req.session.admin,
            setting: setting,
            success: req.flash('success'),
            error: req.flash('error')
        });
    });
});

// Setting Lokasi - Update
router.post('/setting', requireAuth, async (req, res) => {
    const { lat_kantor, long_kantor, radius_meter, durasi_istirahat_menit } = req.body;

    if (!lat_kantor || !long_kantor || !radius_meter) {
        req.flash('error', 'Semua field harus diisi');
        return res.redirect('/admin/setting');
    }

    const durasi = parseInt(durasi_istirahat_menit) || 60;

    const query = 'UPDATE pengaturan SET lat_kantor = ?, long_kantor = ?, radius_meter = ?, durasi_istirahat_menit = ? WHERE id = 1';
    const queryParams = [lat_kantor, long_kantor, radius_meter, durasi];

    db.query(query, queryParams, (err, results) => {
        if (err) {
            req.flash('error', 'Gagal mengupdate pengaturan');
        } else {
            req.flash('success', 'Pengaturan berhasil diupdate');
        }
        res.redirect('/admin/setting');
    });
});

// Logout
router.post('/logout', async (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err);
        }
        res.redirect('/admin/login');
    });
});

// ===== WORK SCHEDULE ROUTES =====

// Work Schedule - List
router.get('/work-schedule', requireAuth, async (req, res) => {
    const { page, limit, q } = getListParams(req, { defaultLimit: 10, maxLimit: 100 });
    const whereClauses = ['ws.deleted_at IS NULL'];
    const queryParams = [];
    if (q) {
        whereClauses.push('(ws.nama LIKE ? OR COALESCE(s.nama_shift, \'\') LIKE ?)');
        const likeQ = `%${q}%`;
        queryParams.push(likeQ, likeQ);
    }
    const whereSql = whereClauses.join(' AND ');

    const countQuery = `
        SELECT COUNT(*) AS total
        FROM jadwal_kerja ws
        LEFT JOIN shift s ON ws.shift_id = s.id
        WHERE ${whereSql}
    `;
    const query = `
        SELECT ws.*,
               ws.nama AS nama,
               ws.hari_kerja AS hari_kerja,
               s.nama_shift AS nama_shift,
               s.jam_masuk AS jam_masuk,
               s.jam_keluar AS jam_keluar,
               COALESCE(ec.employee_count, 0) AS employee_count
        FROM jadwal_kerja ws
        LEFT JOIN shift s ON ws.shift_id = s.id
        LEFT JOIN (
            SELECT id_jadwal_kerja, COUNT(*) AS employee_count
             FROM karyawan
             WHERE deleted_at IS NULL AND id_jadwal_kerja IS NOT NULL
             GROUP BY id_jadwal_kerja
        ) ec ON ws.id = ec.id_jadwal_kerja
        WHERE ${whereSql}
        ORDER BY ws.created_at DESC
    `;
    
    try {
        const countRows = await db.query(countQuery, queryParams);
        const totalItems = countRows[0]?.total || 0;
        const pagination = getPagination(totalItems, page, limit);
        const { safeLimit, safeOffset } = getSafeLimitOffset(pagination);
        const results = await db.query(`${query} LIMIT ${safeLimit} OFFSET ${safeOffset}`, queryParams);
        
        res.render('admin/work-schedule/index', { 
            title: 'Jadwal Kerja - Fleur Atelier',
            admin: req.session.admin,
            currentPage: 'work-schedule',
            schedules: results,
            filters: { q },
            pagination,
            messages: {
                success: req.flash('success'),
                error: req.flash('error')
            }
        });
    } catch (err) {
        console.error('Work schedule list error:', err);
        res.render('admin/work-schedule/index', { 
            title: 'Jadwal Kerja - Fleur Atelier',
            admin: req.session.admin,
            currentPage: 'work-schedule',
            schedules: [],
            filters: { q },
            pagination: getPagination(0, 1, limit),
            messages: {
                success: req.flash('success'),
                error: req.flash('error')
            }
        });
    }
});

// Work Schedule - Add Form
router.get('/work-schedule/add', requireAuth, async (req, res) => {
    const shifts = await db.query(`
        SELECT id, nama_shift, kode_shift
        FROM shift
        WHERE status = TRUE AND deleted_at IS NULL
        ORDER BY nama_shift
    `);
    res.render('admin/work-schedule/add', { 
        title: 'Tambah Jadwal Kerja - Fleur Atelier',
        admin: req.session.admin,
        currentPage: 'work-schedule',
        shifts,
        error: req.flash('error')
    });
});

// Work Schedule - Add Process
router.post('/work-schedule/add', requireAuth, async (req, res) => {
    const { nama, shift_id, work_days } = req.body;
    
    if (!nama) {
        req.flash('error', 'Nama jadwal harus diisi');
        return res.redirect('/admin/work-schedule/add');
    }

    try {
        const workDaysArray = Array.isArray(work_days) ? work_days : [work_days].filter(Boolean);
        // Capitalize first letter to match PascalCase format (Monday, Tuesday, etc.)
        const capitalizedDays = workDaysArray.map(day => day.charAt(0).toUpperCase() + day.slice(1));
        const workDaysJson = JSON.stringify(capitalizedDays);

        const query = `
            INSERT INTO jadwal_kerja (nama, shift_id, hari_kerja, is_active)
            VALUES (?, ?, ?, TRUE)
        `;
        
        await db.query(query, [nama, shift_id || null, workDaysJson]);

        req.flash('success', 'Jadwal kerja berhasil ditambahkan');
        res.redirect('/admin/work-schedule');
    } catch (err) {
        console.error('Add work schedule error:', err);
        req.flash('error', 'Gagal menambah jadwal kerja');
        return res.redirect('/admin/work-schedule/add');
    }
});

// Work Schedule - Show/Detail (with employee assignment)
router.get('/work-schedule/show/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    
    try {
        // Get schedule details
        const scheduleQuery = `
            SELECT ws.*, s.nama_shift AS nama_shift, s.jam_masuk AS jam_masuk, s.jam_keluar AS jam_keluar,
                   ws.hari_kerja AS hari_kerja, ws.nama AS nama
            FROM jadwal_kerja ws
            LEFT JOIN shift s ON s.id = ws.shift_id
            WHERE ws.id = ? AND ws.deleted_at IS NULL
        `;
        const scheduleResults = await db.query(scheduleQuery, [id]);
        
        if (!scheduleResults || scheduleResults.length === 0) {
            req.flash('error', 'Jadwal kerja tidak ditemukan');
            return res.redirect('/admin/work-schedule');
        }
        
        const schedule = scheduleResults[0];
        
        // Get karyawan assigned to this schedule
        const assignedQuery = `
            SELECT e.id, e.nik, e.nama AS nama, p.nama_jabatan AS jabatan
            FROM karyawan e
            LEFT JOIN jabatan p ON e.id_jabatan = p.id
            WHERE e.id_jadwal_kerja = ? AND e.deleted_at IS NULL
            ORDER BY e.nama
        `;
        const assignedEmployees = await db.query(assignedQuery, [id]);
        
        // Get available karyawan (not assigned to this schedule)
        const availableQuery = `
            SELECT e.id, e.nik, e.nama AS nama, p.nama_jabatan AS jabatan
            FROM karyawan e
            LEFT JOIN jabatan p ON e.id_jabatan = p.id
            WHERE (e.id_jadwal_kerja IS NULL OR e.id_jadwal_kerja != ?) AND e.deleted_at IS NULL
            ORDER BY e.nama
        `;
        const availableEmployees = await db.query(availableQuery, [id]);
        
        res.render('admin/work-schedule/show', {
            title: 'Detail Jadwal Kerja - Fleur Atelier',
            admin: req.session.admin,
            currentPage: 'work-schedule',
            schedule: schedule,
            assignedEmployees: assignedEmployees,
            availableEmployees: availableEmployees,
            messages: {
                success: req.flash('success'),
                error: req.flash('error')
            }
        });
    } catch (err) {
        console.error('Show schedule error:', err);
        req.flash('error', 'Gagal memuat detail jadwal kerja');
        return res.redirect('/admin/work-schedule');
    }
});

// Work Schedule - Edit Form
router.get('/work-schedule/edit/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    
    try {
        const query = 'SELECT * FROM jadwal_kerja WHERE id = ? AND deleted_at IS NULL';
        const results = await db.query(query, [id]);
        const shifts = await db.query(`
            SELECT id, nama_shift, kode_shift
            FROM shift
            WHERE deleted_at IS NULL
            ORDER BY nama_shift
        `);
        
        if (!results || results.length === 0) {
            req.flash('error', 'Jadwal kerja tidak ditemukan');
            return res.redirect('/admin/work-schedule');
        }
        
        // Map database fields to view fields
        const schedule = {
            id: results[0].id,
            name: results[0].nama,
            shift_id: results[0].shift_id,
            work_days: results[0].hari_kerja
        };
        
        res.render('admin/work-schedule/edit', { 
            title: 'Edit Jadwal Kerja - Fleur Atelier',
            admin: req.session.admin,
            currentPage: 'work-schedule',
            schedule: schedule,
            shifts,
            error: req.flash('error')
        });
    } catch (err) {
        console.error('Work schedule edit error:', err);
        req.flash('error', 'Gagal memuat data jadwal kerja');
        return res.redirect('/admin/work-schedule');
    }
});

// Work Schedule - Update Process
router.post('/work-schedule/update', requireAuth, async (req, res) => {
    const { id, nama, shift_id, work_days } = req.body;
    
    if (!id || !nama) {
        req.flash('error', 'Nama jadwal harus diisi');
        return res.redirect(`/admin/work-schedule/edit/${id}`);
    }

    try {
        const workDaysArray = Array.isArray(work_days) ? work_days : [work_days].filter(Boolean);
        // Capitalize first letter to match PascalCase format (Monday, Tuesday, etc.)
        const capitalizedDays = workDaysArray.map(day => day.charAt(0).toUpperCase() + day.slice(1));
        const workDaysJson = JSON.stringify(capitalizedDays);

        const query = `
            UPDATE jadwal_kerja
            SET nama = ?, shift_id = ?, hari_kerja = ?
            WHERE id = ? AND deleted_at IS NULL
        `;
        
        const results = await db.query(query, [nama, shift_id || null, workDaysJson, id]);

        if (results.affectedRows === 0) {
            req.flash('error', 'Jadwal kerja tidak ditemukan');
            return res.redirect('/admin/work-schedule');
        }

        req.flash('success', 'Jadwal kerja berhasil diupdate');
        res.redirect('/admin/work-schedule');
    } catch (err) {
        console.error('Update work schedule error:', err);
        req.flash('error', 'Gagal mengupdate jadwal kerja');
        return res.redirect(`/admin/work-schedule/edit/${id}`);
    }
});

// Work Schedule - Activate (API)
router.post('/work-schedule/activate', requireAuth, async (req, res) => {
    const { id } = req.body;
    
    if (!id) {
        return res.json({ success: false, message: 'ID jadwal harus diisi' });
    }

    try {
        // First, deactivate all schedules
        const deactivateQuery = 'UPDATE jadwal_kerja SET is_active = FALSE WHERE deleted_at IS NULL';
        await db.query(deactivateQuery);

        // Then activate the selected schedule
        const activateQuery = 'UPDATE jadwal_kerja SET is_active = TRUE WHERE id = ? AND deleted_at IS NULL';
        const results = await db.query(activateQuery, [id]);

        if (results.affectedRows === 0) {
            return res.json({ success: false, message: 'Jadwal tidak ditemukan' });
        }

        res.json({ success: true, message: 'Jadwal berhasil diaktifkan' });
    } catch (err) {
        console.error('Activate schedule error:', err);
        return res.json({ success: false, message: 'Gagal mengaktifkan jadwal' });
    }
});

// Work Schedule - Delete
router.post('/work-schedule/delete/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    
    try {
        // Check if schedule is being used by any employee
        const checkQuery = 'SELECT COUNT(*) as count FROM karyawan WHERE id_jadwal_kerja = ? AND deleted_at IS NULL';
        const checkResults = await db.query(checkQuery, [id]);

        if (checkResults[0].count > 0) {
            req.flash('error', 'Tidak dapat menghapus jadwal kerja yang sedang digunakan oleh karyawan');
            return res.redirect('/admin/work-schedule');
        }

        // Safe to delete
        const deleteQuery = 'UPDATE jadwal_kerja SET deleted_at = NOW(), is_active = FALSE WHERE id = ? AND deleted_at IS NULL';
        await db.query(deleteQuery, [id]);
        
        req.flash('success', 'Jadwal kerja berhasil dihapus');
        res.redirect('/admin/work-schedule');
    } catch (err) {
        console.error('Delete schedule error:', err);
        req.flash('error', 'Gagal menghapus jadwal kerja');
        res.redirect('/admin/work-schedule');
    }
});

// Work Schedule - Assign Employee
router.post('/work-schedule/:id/assign', requireAuth, async (req, res) => {
    const { id } = req.params;
    const { id_karyawan } = req.body;
    
    if (!id_karyawan) {
        req.flash('error', 'Pilih karyawan yang akan di-assign');
        return res.redirect(`/admin/work-schedule/show/${id}`);
    }
    
    try {
        // Update employee's id_jadwal_kerja
        const updateQuery = 'UPDATE karyawan SET id_jadwal_kerja = ? WHERE id = ? AND deleted_at IS NULL';
        const results = await db.query(updateQuery, [id, id_karyawan]);
        
        if (results.affectedRows === 0) {
            req.flash('error', 'Karyawan tidak ditemukan');
            return res.redirect(`/admin/work-schedule/show/${id}`);
        }
        
        req.flash('success', 'Karyawan berhasil di-assign ke jadwal kerja');
        res.redirect(`/admin/work-schedule/show/${id}`);
    } catch (err) {
        console.error('Assign employee error:', err);
        req.flash('error', 'Gagal assign karyawan');
        res.redirect(`/admin/work-schedule/show/${id}`);
    }
});

// Work Schedule - Unassign Employee
router.post('/work-schedule/:id/unassign', requireAuth, async (req, res) => {
    const { id } = req.params;
    const { id_karyawan } = req.body;
    
    if (!id_karyawan) {
        req.flash('error', 'ID karyawan tidak valid');
        return res.redirect(`/admin/work-schedule/show/${id}`);
    }
    
    try {
        // Set employee's id_jadwal_kerja to NULL
        const updateQuery = 'UPDATE karyawan SET id_jadwal_kerja = NULL WHERE id = ? AND id_jadwal_kerja = ? AND deleted_at IS NULL';
        const results = await db.query(updateQuery, [id_karyawan, id]);
        
        if (results.affectedRows === 0) {
            req.flash('error', 'Karyawan tidak ditemukan atau tidak di-assign ke jadwal ini');
            return res.redirect(`/admin/work-schedule/show/${id}`);
        }
        
        req.flash('success', 'Karyawan berhasil di-unassign dari jadwal kerja');
        res.redirect(`/admin/work-schedule/show/${id}`);
    } catch (err) {
        console.error('Unassign employee error:', err);
        req.flash('error', 'Gagal unassign karyawan');
        res.redirect(`/admin/work-schedule/show/${id}`);
    }
});

// ===== JABATAN CRUD ROUTES =====

// Jabatan - Page List (Daftar Jabatan)
router.get('/jabatan', requireAuth, async (req, res) => {
    const { page, limit, q } = getListParams(req, { defaultLimit: 10, maxLimit: 100 });
    const whereClauses = ['j.deleted_at IS NULL'];
    const queryParams = [];

    if (q) {
        whereClauses.push(`(
            j.nama_jabatan LIKE ?
            OR COALESCE(j.deskripsi, '') LIKE ?
            OR COALESCE(j.kode, '') LIKE ?
        )`);
        const likeQ = `%${q}%`;
        queryParams.push(likeQ, likeQ, likeQ);
    }

    const whereSql = whereClauses.join(' AND ');
    const countQuery = `SELECT COUNT(*) AS total FROM jabatan j WHERE ${whereSql}`;
    const listQuery = `
        SELECT
            j.id,
            j.kode,
            j.nama_jabatan,
            j.deskripsi,
            j.created_at,
            (SELECT COUNT(*) FROM karyawan k WHERE k.id_jabatan = j.id AND k.deleted_at IS NULL) AS karyawan_count
        FROM jabatan j
        WHERE ${whereSql}
        ORDER BY j.nama_jabatan ASC
    `;

    try {
        const countRows = await db.query(countQuery, queryParams);
        const totalItems = countRows[0]?.total || 0;
        const pagination = getPagination(totalItems, page, limit);
        const { safeLimit, safeOffset } = getSafeLimitOffset(pagination);
        const results = await db.query(`${listQuery} LIMIT ${safeLimit} OFFSET ${safeOffset}`, queryParams);

        res.render('admin/jabatan/index', {
            title: 'Kelola Jabatan - Fleur Atelier',
            admin: req.session.admin,
            jabatan: results,
            filters: { q },
            pagination,
            success: req.flash('success'),
            error: req.flash('error')
        });
    } catch (err) {
        console.error('Jabatan list page error:', err);
        return res.render('admin/jabatan/index', {
            title: 'Kelola Jabatan - Fleur Atelier',
            admin: req.session.admin,
            jabatan: [],
            filters: { q },
            pagination: getPagination(0, 1, limit),
            success: req.flash('success'),
            error: req.flash('error')
        });
    }
});

// Get jabatan list (API)
router.get('/jabatan/list', requireAuth, async (req, res) => {
    try {
        const query = 'SELECT id, kode, nama_jabatan, deskripsi FROM jabatan WHERE deleted_at IS NULL ORDER BY nama_jabatan';
        const results = await db.query(query);
        res.json({ success: true, data: results });
    } catch (err) {
        console.error('Get jabatan list error:', err);
        return res.json({ success: false, message: 'Database error' });
    }
});

// Get schedules list (API)
router.get('/schedules/list', requireAuth, async (req, res) => {
    try {
        const query = `
            SELECT ws.id, ws.nama AS nama, s.jam_masuk AS jam_masuk, s.jam_keluar AS jam_keluar
            FROM jadwal_kerja ws
            LEFT JOIN shift s ON s.id = ws.shift_id
            WHERE ws.is_active = TRUE AND ws.deleted_at IS NULL
            ORDER BY s.jam_masuk
        `;
        const results = await db.query(query);
        res.json({ success: true, data: results });
    } catch (err) {
        console.error('Get schedules list error:', err);
        return res.json({ success: false, message: 'Database error' });
    }
});

// Add new jabatan (API)
router.post('/jabatan/add', requireAuth, async (req, res) => {
    const { nama_jabatan, deskripsi } = req.body;
    
    if (!nama_jabatan || nama_jabatan.trim() === '') {
        return res.json({ success: false, message: 'Nama jabatan harus diisi' });
    }

    try {
        const kode = `JAB-${Date.now()}`;
        const query = 'INSERT INTO jabatan (kode, nama_jabatan, deskripsi) VALUES (?, ?, ?)';
        const results = await db.query(query, [kode, nama_jabatan.trim(), deskripsi || null]);

        res.json({ 
            success: true, 
            message: 'Jabatan berhasil ditambahkan',
            data: {
                id: results.insertId,
                kode,
                nama_jabatan: nama_jabatan.trim(),
                deskripsi: deskripsi || null
            }
        });
    } catch (err) {
        console.error('Add jabatan error:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.json({ success: false, message: 'Nama jabatan sudah ada' });
        }
        return res.json({ success: false, message: 'Gagal menambah jabatan' });
    }
});

// Update jabatan (API)
router.post('/jabatan/update', requireAuth, async (req, res) => {
    const { id, nama_jabatan, deskripsi } = req.body;
    
    if (!id || !nama_jabatan || nama_jabatan.trim() === '') {
        return res.json({ success: false, message: 'ID dan nama jabatan harus diisi' });
    }

    try {
        const query = 'UPDATE jabatan SET nama_jabatan = ?, deskripsi = ? WHERE id = ? AND deleted_at IS NULL';
        const results = await db.query(query, [nama_jabatan.trim(), deskripsi || null, id]);

        if (results.affectedRows === 0) {
            return res.json({ success: false, message: 'Jabatan tidak ditemukan' });
        }

        res.json({ success: true, message: 'Jabatan berhasil diupdate' });
    } catch (err) {
        console.error('Update jabatan error:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.json({ success: false, message: 'Nama jabatan sudah ada' });
        }
        return res.json({ success: false, message: 'Gagal mengupdate jabatan' });
    }
});

// Delete jabatan (API)
router.post('/jabatan/delete', requireAuth, async (req, res) => {
    const { id } = req.body;
    
    if (!id) {
        return res.json({ success: false, message: 'ID jabatan harus diisi' });
    }

    try {
        // Check if jabatan is being used by any karyawan
        const checkResults = await db.query(
            'SELECT COUNT(*) as count FROM karyawan WHERE id_jabatan = ? AND deleted_at IS NULL', [id]
        );

        if (checkResults[0].count > 0) {
            return res.json({ 
                success: false, 
                message: 'Tidak dapat menghapus jabatan yang sedang digunakan oleh karyawan' 
            });
        }

        const results = await db.query('UPDATE jabatan SET deleted_at = NOW(), is_active = FALSE WHERE id = ? AND deleted_at IS NULL', [id]);

        if (results.affectedRows === 0) {
            return res.json({ success: false, message: 'Jabatan tidak ditemukan' });
        }

        res.json({ success: true, message: 'Jabatan berhasil dihapus' });
    } catch (err) {
        console.error('Delete jabatan error:', err);
        return res.json({ success: false, message: 'Gagal menghapus jabatan' });
    }
});

// Face Recognition Testing Page
router.get('/face-test', requireAuth, async (req, res) => {
    res.render('admin/face-test', { 
        title: 'Face Recognition Testing - Fleur Atelier',
        admin: req.session.admin,
        currentPage: 'face-test'
    });
});

// API: Get employee list for testing
router.get('/api/karyawan/list', requireAuth, async (req, res) => {
    const query = `
        SELECT e.id, e.nik, e.nama AS nama, e.email, e.phone,
               p.nama_jabatan AS nama_jabatan,
               (SELECT COUNT(*) FROM karyawan_face_reference WHERE id_karyawan = e.id AND is_active = TRUE) as has_reference
        FROM karyawan e
        LEFT JOIN jabatan p ON e.id_jabatan = p.id
        WHERE e.status = 'active' AND e.deleted_at IS NULL
        ORDER BY e.nama ASC
    `;
    
    db.query(query, (err, results) => {
        if (err) {
            console.error('Error fetching karyawan:', err);
            return res.json({ success: false, message: 'Gagal memuat daftar karyawan' });
        }
        
        res.json({ 
            success: true, 
            data: results.map(emp => ({
                ...emp,
                has_reference: emp.has_reference > 0
            }))
        });
    });
});

// API: Get employee face reference
router.get('/api/karyawan/:id/face-reference', requireAuth, async (req, res) => {
    const { id } = req.params;
    
    const query = `
        SELECT * FROM karyawan_face_reference
        WHERE id_karyawan = ? AND is_active = TRUE
        ORDER BY created_at DESC
        LIMIT 1
    `;
    
    db.query(query, [id], (err, results) => {
        if (err) {
            console.error('Error fetching face reference:', err);
            return res.json({ success: false, message: 'Gagal memuat referensi wajah' });
        }
        
        if (results.length === 0) {
            return res.json({ success: false, message: 'Karyawan belum memiliki foto referensi' });
        }
        
        res.json({ success: true, data: results[0] });
    });
});

// API: Generate test token for employee
router.post('/api/karyawan/generate-test-token', requireAuth, async (req, res) => {
    const { employeeId } = req.body;
    
    if (!employeeId) {
        return res.json({ success: false, message: 'Employee ID is required' });
    }
    
    // Get employee data
    const query = "SELECT id, nik, nama AS nama FROM karyawan WHERE id = ? AND status = 'active' AND deleted_at IS NULL";
    
    db.query(query, [employeeId], (err, results) => {
        if (err) {
            console.error('Error fetching employee:', err);
            return res.json({ success: false, message: 'Gagal memuat data karyawan' });
        }
        
        if (results.length === 0) {
            return res.json({ success: false, message: 'Karyawan tidak ditemukan' });
        }
        
        const employee = results[0];
        
        // Generate JWT token for testing
        const { generateAccessToken } = require('../utils/jwt');
        const testToken = generateAccessToken({
            id: employee.id,
            nik: employee.nik,
            isTestMode: true // Flag to indicate this is a test token
        });
        
        res.json({
            success: true,
            data: {
                token: testToken,
                employee: {
                    id: employee.id,
                    nik: employee.nik,
                    nama: employee.nama
                }
            }
        });
    });
});

// API: Upload test reference (Admin only - no JWT required)
router.post('/api/test/upload-reference', requireAuth, async (req, res) => {
    testUpload.single('reference')(req, res, async function(err) {
        if (err instanceof multer.MulterError) {
            console.error('Multer error:', err);
            return res.json({
                success: false,
                message: 'Upload error: ' + err.message,
                code: 'MULTER_ERROR'
            });
        } else if (err) {
            console.error('Upload error:', err);
            return res.json({
                success: false,
                message: 'Upload error: ' + err.message,
                code: 'UPLOAD_ERROR'
            });
        }
        
        try {
            if (!req.file) {
                return res.json({
                    success: false,
                    message: 'No image file provided',
                    code: 'NO_FILE'
                });
            }

            console.log('Test reference uploaded:', req.file.filename);
            const imagePath = req.file.path;
            
            // Detect faces using AI
            const { detectFaces } = require('../utils/face-recognition');
            console.log('Detecting faces in:', imagePath);
            const faces = await detectFaces(imagePath);
            console.log('Faces detected:', faces.length);
            
            if (faces.length === 0) {
                // Delete uploaded file if no faces detected
                if (fs.existsSync(imagePath)) {
                    fs.unlinkSync(imagePath);
                }
                return res.json({
                    success: false,
                    message: 'No faces detected in the image',
                    code: 'NO_FACES'
                });
            }

            // Store reference data temporarily (in memory)
            const testId = `test_${Date.now()}_admin`;
            
            global.testReferences = global.testReferences || {};
            global.testReferences[testId] = {
                filename: req.file.filename,
                originalName: req.file.originalname,
                filePath: imagePath,
                faces: faces,
                uploadTime: new Date().toLocaleString('en-US', { timeZone: 'Asia/Makassar' }),
                adminId: req.session.admin.id
            };

            console.log('Test reference stored with ID:', testId);

            res.json({
                success: true,
                message: 'Test reference photo uploaded successfully',
                data: {
                    testId: testId,
                    filename: req.file.filename,
                    originalName: req.file.originalname,
                    facesDetected: faces.length,
                    faces: faces,
                    uploadTime: new Date().toLocaleString('en-US', { timeZone: 'Asia/Makassar' })
                }
            });

        } catch (error) {
            console.error('Upload test reference error:', error);
            
            // Delete uploaded file on error
            if (req.file && fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
            
            res.json({
                success: false,
                message: 'Failed to process test reference image: ' + error.message,
                code: 'PROCESSING_ERROR'
            });
        }
    });
});

// API: Test face matching (Admin only - no JWT required)
router.post('/api/test/match-face', requireAuth, async (req, res) => {
    testUpload.single('photo')(req, res, async function(err) {
        if (err instanceof multer.MulterError) {
            console.error('Multer error:', err);
            return res.json({
                success: false,
                message: 'Upload error: ' + err.message,
                code: 'MULTER_ERROR'
            });
        } else if (err) {
            console.error('Upload error:', err);
            return res.json({
                success: false,
                message: 'Upload error: ' + err.message,
                code: 'UPLOAD_ERROR'
            });
        }
        
        try {
            const { testId } = req.body;

            if (!req.file) {
                return res.json({
                    success: false,
                    message: 'No image file provided',
                    code: 'NO_FILE'
                });
            }

            if (!testId) {
                if (fs.existsSync(req.file.path)) {
                    fs.unlinkSync(req.file.path);
                }
                return res.json({
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
                return res.json({
                    success: false,
                    message: 'Test reference not found. Please upload reference first.',
                    code: 'NO_TEST_REFERENCE'
                });
            }

            console.log('Matching face against test ID:', testId);
            const imagePath = req.file.path;
            
            // Detect faces in uploaded photo
            const { detectFaces, compareFaces } = require('../utils/face-recognition');
            console.log('Detecting faces in test photo:', imagePath);
            const detectedFaces = await detectFaces(imagePath);
            console.log('Detected faces:', detectedFaces.length);

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
                        summary: {
                            totalFaces: 0,
                            matchedFaces: 0,
                            averageSimilarity: 0,
                            highestSimilarity: 0
                        },
                        message: 'No faces detected in test photo'
                    }
                });
            }

            // Compare faces with test reference
            console.log('Comparing faces...');
            const matchResults = await compareFaces(testReference.faces, detectedFaces);
            console.log('Match results:', matchResults.length, 'faces compared');

            res.json({
                success: true,
                message: 'Face matching test completed',
                data: {
                    testId: testId,
                    facesDetected: detectedFaces.length,
                    faces: detectedFaces,
                    matchResults: matchResults,
                    reference: {
                        filename: testReference.originalName || testReference.employeeName,
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
            
            res.json({
                success: false,
                message: 'Failed to test face matching: ' + error.message,
                code: 'PROCESSING_ERROR'
            });
        }
    });
});

// ===== SHIFT ROUTES =====

router.get('/shift', requireAuth, async (req, res) => {
    try {
        const { page, limit, q } = getListParams(req, { defaultLimit: 10, maxLimit: 100 });
        const whereClauses = ['s.deleted_at IS NULL'];
        const queryParams = [];
        if (q) {
            whereClauses.push('(s.nama_shift LIKE ? OR COALESCE(s.kode_shift, \'\') LIKE ?)');
            const likeQ = `%${q}%`;
            queryParams.push(likeQ, likeQ);
        }
        const whereSql = whereClauses.join(' AND ');

        const countRows = await db.query(`
            SELECT COUNT(*) AS total
            FROM shift s
            WHERE ${whereSql}
        `, queryParams);
        const totalItems = countRows[0]?.total || 0;
        const pagination = getPagination(totalItems, page, limit);
        const { safeLimit, safeOffset } = getSafeLimitOffset(pagination);

        const shifts = await db.query(`
            SELECT s.*,
                   COUNT(DISTINCT ws.id) AS schedule_count,
                   COUNT(DISTINCT e.id) AS employee_count
            FROM shift s
            LEFT JOIN jadwal_kerja ws ON ws.shift_id = s.id AND ws.deleted_at IS NULL
            LEFT JOIN (
                SELECT k.id, COALESCE(k.shift_id, kjk.shift_id) AS eff_shift
                FROM karyawan k
                LEFT JOIN jadwal_kerja kjk ON kjk.id = k.id_jadwal_kerja
                WHERE k.deleted_at IS NULL
            ) e ON e.eff_shift = s.id
            WHERE ${whereSql}
            GROUP BY s.id
            ORDER BY s.created_at DESC
            LIMIT ${safeLimit} OFFSET ${safeOffset}
        `, queryParams);

        res.render('admin/shift/index', {
            title: 'Kelola Shift - Fleur Atelier',
            admin: req.session.admin,
            currentPage: 'shift',
            shifts,
            filters: { q },
            pagination,
            messages: {
                success: req.flash('success'),
                error: req.flash('error')
            }
        });
    } catch (error) {
        console.error('Shift list error:', error);
        res.render('admin/shift/index', {
            title: 'Kelola Shift - Fleur Atelier',
            admin: req.session.admin,
            currentPage: 'shift',
            shifts: [],
            filters: { q: (req.query.q || '').toString().trim() },
            pagination: getPagination(0, 1, 10),
            messages: {
                success: req.flash('success'),
                error: req.flash('error')
            }
        });
    }
});

router.get('/shift/add', requireAuth, async (req, res) => {
    res.render('admin/shift/add', {
        title: 'Tambah Shift - Fleur Atelier',
        admin: req.session.admin,
        currentPage: 'shift',
        error: req.flash('error')
    });
});

router.post('/shift/add', requireAuth, async (req, res) => {
    const {
        nama_shift,
        kode_shift,
        jam_masuk,
        jam_keluar
    } = req.body;

    if (!nama_shift || !jam_masuk || !jam_keluar) {
        req.flash('error', 'Nama shift, jam masuk, dan jam keluar harus diisi');
        return res.redirect('/admin/shift/add');
    }

    try {
        await db.query(`
            INSERT INTO shift (nama_shift, kode_shift, jam_masuk, jam_keluar)
            VALUES (?, ?, ?, ?)
        `, [
            nama_shift,
            kode_shift || null,
            jam_masuk,
            jam_keluar
        ]);

        req.flash('success', 'Shift berhasil ditambahkan');
        res.redirect('/admin/shift');
    } catch (error) {
        console.error('Add shift error:', error);
        req.flash('error', 'Gagal menambah shift');
        res.redirect('/admin/shift/add');
    }
});

router.get('/shift/edit/:id', requireAuth, async (req, res) => {
    try {
        const shift = await db.query(`
            SELECT
                id,
                nama_shift,
                kode_shift,
                jam_masuk,
                jam_keluar,
                status
            FROM shift
            WHERE id = ? AND deleted_at IS NULL
        `, [req.params.id]);
        if (!shift.length) {
            req.flash('error', 'Shift tidak ditemukan');
            return res.redirect('/admin/shift');
        }

        res.render('admin/shift/edit', {
            title: 'Edit Shift - Fleur Atelier',
            admin: req.session.admin,
            currentPage: 'shift',
            shift: shift[0],
            error: req.flash('error')
        });
    } catch (error) {
        console.error('Edit shift error:', error);
        req.flash('error', 'Gagal memuat data shift');
        res.redirect('/admin/shift');
    }
});

router.post('/shift/update', requireAuth, async (req, res) => {
    const {
        id,
        nama_shift,
        kode_shift,
        jam_masuk,
        jam_keluar,
        status
    } = req.body;

    try {
        await db.query(`
            UPDATE shift
            SET nama_shift = ?, kode_shift = ?, jam_masuk = ?, jam_keluar = ?,
                status = ?
            WHERE id = ? AND deleted_at IS NULL
        `, [
            nama_shift,
            kode_shift || null,
            jam_masuk,
            jam_keluar,
            status ? 1 : 0,
            id
        ]);

        req.flash('success', 'Shift berhasil diperbarui');
        res.redirect('/admin/shift');
    } catch (error) {
        console.error('Update shift error:', error);
        req.flash('error', 'Gagal memperbarui shift');
        res.redirect(`/admin/shift/edit/${id}`);
    }
});

router.post('/shift/delete/:id', requireAuth, async (req, res) => {
    try {
        const usage = await db.query(`
            SELECT
                (SELECT COUNT(*) FROM jadwal_kerja WHERE shift_id = ? AND deleted_at IS NULL) AS schedule_count,
                (SELECT COUNT(*) FROM karyawan WHERE shift_id = ? AND deleted_at IS NULL) AS employee_count
        `, [req.params.id, req.params.id]);

        if (usage[0].schedule_count > 0 || usage[0].employee_count > 0) {
            req.flash('error', 'Shift tidak dapat dihapus karena masih dipakai');
            return res.redirect('/admin/shift');
        }

        await db.query('UPDATE shift SET deleted_at = NOW(), status = FALSE WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
        req.flash('success', 'Shift berhasil dihapus');
        res.redirect('/admin/shift');
    } catch (error) {
        console.error('Delete shift error:', error);
        req.flash('error', 'Gagal menghapus shift');
        res.redirect('/admin/shift');
    }
});

// ===== MANAGER ACCOUNT ROUTES =====
router.get('/manager-accounts', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        const { page, limit, q } = getListParams(req, { defaultLimit: 10, maxLimit: 100 });
        const searchFilter = q ? 'AND username LIKE ?' : '';
        const queryParams = q ? [`%${q}%`] : [];

        const countRows = await db.query(
            `SELECT COUNT(*) AS total FROM user WHERE role = 'manager' ${searchFilter}`,
            queryParams
        );
        const totalItems = countRows[0]?.total || 0;
        const pagination = getPagination(totalItems, page, limit);
        const { safeLimit, safeOffset } = getSafeLimitOffset(pagination);

        const accounts = await db.query(
            `SELECT id, username, created_at FROM user
             WHERE role = 'manager' ${searchFilter}
             ORDER BY created_at DESC
             LIMIT ${safeLimit} OFFSET ${safeOffset}`,
            queryParams
        );

        res.render('admin/manager-accounts/index', {
            title: 'Akun Manager - Fleur Atelier',
            admin: req.session.admin,
            currentPage: 'manager-accounts',
            accounts,
            filters: { q },
            pagination,
            messages: {
                success: req.flash('success'),
                error: req.flash('error')
            }
        });
    } catch (error) {
        console.error('Manager account list error:', error);
        res.render('admin/manager-accounts/index', {
            title: 'Akun Manager - Fleur Atelier',
            admin: req.session.admin,
            currentPage: 'manager-accounts',
            accounts: [],
            filters: { q: (req.query.q || '').toString().trim() },
            pagination: getPagination(0, 1, 10),
            messages: {
                success: req.flash('success'),
                error: req.flash('error')
            }
        });
    }
});

router.post('/manager-accounts/add', requireAuth, requireSuperAdmin, async (req, res) => {
    const normalizedUsername = (req.body.username || '').trim();
    const normalizedPassword = (req.body.password || '').trim();
    try {
        if (!normalizedUsername || !normalizedPassword) {
            req.flash('error', 'Username dan password wajib diisi');
            return res.redirect('/admin/manager-accounts');
        }

        const existsRows = await db.query(
            'SELECT id FROM user WHERE username = ? LIMIT 1',
            [normalizedUsername]
        );
        if (existsRows.length) {
            req.flash('error', 'Username sudah dipakai');
            return res.redirect('/admin/manager-accounts');
        }

        const hashedPassword = await bcrypt.hash(normalizedPassword, 10);
        await db.query(
            "INSERT INTO user (username, password, role) VALUES (?, ?, 'manager')",
            [normalizedUsername, hashedPassword]
        );
        req.flash('success', 'Akun manager berhasil dibuat');
        return res.redirect('/admin/manager-accounts');
    } catch (error) {
        console.error('Add manager account error:', error);
        req.flash('error', 'Gagal membuat akun manager');
        return res.redirect('/admin/manager-accounts');
    }
});

router.post('/manager-accounts/:id/delete', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        const result = await db.query(
            "DELETE FROM user WHERE id = ? AND role = 'manager'",
            [req.params.id]
        );
        if (!result.affectedRows) {
            req.flash('error', 'Akun manager tidak ditemukan');
            return res.redirect('/admin/manager-accounts');
        }
        req.flash('success', 'Akun manager berhasil dihapus');
        return res.redirect('/admin/manager-accounts');
    } catch (error) {
        console.error('Delete manager account error:', error);
        req.flash('error', 'Gagal menghapus akun manager');
        return res.redirect('/admin/manager-accounts');
    }
});

router.post('/manager-accounts/:id/reset-password', requireAuth, requireSuperAdmin, async (req, res) => {
    const { new_password } = req.body;
    try {
        if (!new_password) {
            req.flash('error', 'Password baru wajib diisi');
            return res.redirect('/admin/manager-accounts');
        }
        const hashedPassword = await bcrypt.hash(new_password, 10);
        const result = await db.query("UPDATE user SET password = ? WHERE id = ? AND role = 'manager'", [hashedPassword, req.params.id]);
        if (!result.affectedRows) {
            req.flash('error', 'Akun manager tidak ditemukan');
            return res.redirect('/admin/manager-accounts');
        }
        req.flash('success', 'Password akun manager berhasil direset');
        return res.redirect('/admin/manager-accounts');
    } catch (error) {
        console.error('Reset manager password error:', error);
        req.flash('error', 'Gagal mereset password akun manager');
        return res.redirect('/admin/manager-accounts');
    }
});

// ===== ABSENSI & APPROVAL =====

router.get('/manager-dashboard', requireAuth, requireManager, async (req, res) => {
    try {
        const summaryRows = await db.query(`
            SELECT
                (SELECT COUNT(*) FROM absensi WHERE status IN ('pending', 'menunggu_manager') AND DATE(created_at) = CURDATE()) AS pending_today,
                (SELECT COUNT(*) FROM absensi WHERE status IN ('approved', 'disetujui') AND DATE(approved_at) = CURDATE()) AS approved_today,
                (SELECT COUNT(*) FROM absensi WHERE status IN ('rejected', 'ditolak', 'ditolak_pengganti') AND DATE(approved_at) = CURDATE()) AS rejected_today,
                (SELECT COUNT(*) FROM absensi WHERE status IN ('pending', 'menunggu_manager')) AS pending_total
        `);

        const recentApprovals = await db.query(`
            SELECT
                lr.id,
                e.nama AS nama_karyawan,
                lr.jenis AS jenis,
                lr.kategori AS kategori,
                lr.status,
                lr.approval_notes,
                lr.approval_notes AS rejection_reason,
                lr.approved_at,
                'Manager' AS approver_name
            FROM absensi lr
            INNER JOIN karyawan e ON e.id = lr.id_karyawan
            WHERE lr.status IN ('approved', 'rejected', 'disetujui', 'ditolak', 'ditolak_pengganti')
            ORDER BY lr.approved_at DESC
            LIMIT 10
        `);

        res.render('admin/manager/dashboard', {
            title: 'Dashboard Ringkas Tim - Fleur Atelier',
            admin: req.session.admin,
            currentPage: 'manager-dashboard',
            summary: summaryRows[0] || {
                pending_today: 0,
                approved_today: 0,
                rejected_today: 0,
                pending_total: 0
            },
            recentApprovals,
            messages: {
                success: req.flash('success'),
                error: req.flash('error')
            }
        });
    } catch (error) {
        console.error('Manager dashboard error:', error);
        res.render('admin/manager/dashboard', {
            title: 'Dashboard Ringkas Tim - Fleur Atelier',
            admin: req.session.admin,
            currentPage: 'manager-dashboard',
            summary: {
                pending_today: 0,
                approved_today: 0,
                rejected_today: 0,
                pending_total: 0
            },
            recentApprovals: [],
            messages: {
                success: req.flash('success'),
                error: req.flash('error')
            }
        });
    }
});

router.get('/approval-history', requireAuth, requireManager, async (req, res) => {
    req.flash('error', 'Riwayat approval log sudah dihapus dari sistem');
    return res.redirect('/admin/absensi');
});

router.get('/ketidakhadiran', requireAuth, requireManager, (req, res) => {
    res.redirect('/admin/absensi');
});

router.get('/absensi', requireAuth, async (req, res) => {
    try {
        const { page, limit, q } = getListParams(req, { defaultLimit: 10, maxLimit: 100 });
        const whereClauses = ['1=1'];
        const queryParams = [];
        if (q) {
            whereClauses.push(`(
                e.nama LIKE ?
                OR e.nik LIKE ?
                OR lr.jenis LIKE ?
                OR lr.kategori LIKE ?
                OR lr.status LIKE ?
                OR COALESCE(lr.alasan, '') LIKE ?
            )`);
            const likeQ = `%${q}%`;
            queryParams.push(likeQ, likeQ, likeQ, likeQ, likeQ, likeQ);
        }
        const whereSql = whereClauses.join(' AND ');

        const countRows = await db.query(`
            SELECT COUNT(*) AS total
            FROM absensi lr
            JOIN karyawan e ON e.id = lr.id_karyawan
            WHERE ${whereSql}
        `, queryParams);
        const totalItems = countRows[0]?.total || 0;
        const pagination = getPagination(totalItems, page, limit);
        const { safeLimit, safeOffset } = getSafeLimitOffset(pagination);

        const requests = await db.query(`
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
                   lr.approval_notes AS rejection_reason,
                   lr.approved_at,
                   lr.created_at,
                   lr.updated_at,
                   e.nama AS nama_karyawan,
                   e.nik,
                   CASE
                       WHEN lr.status IN ('approved', 'rejected', 'disetujui', 'ditolak') THEN 'Manager'
                       WHEN lr.status = 'ditolak_pengganti' AND pengganti.nama IS NOT NULL THEN pengganti.nama
                       ELSE '-'
                   END AS nama_approver
            FROM absensi lr
            JOIN karyawan e ON e.id = lr.id_karyawan
            LEFT JOIN permintaan_absensi pa ON pa.id_absensi = lr.id
            LEFT JOIN karyawan pengganti ON pengganti.id = pa.id_pengganti
            WHERE ${whereSql}
            ORDER BY lr.created_at DESC
            LIMIT ${safeLimit} OFFSET ${safeOffset}
        `, queryParams);

        const employeeWhereClauses = ['e.deleted_at IS NULL'];
        const employeeParams = [];
        if (q) {
            employeeWhereClauses.push(`(
                e.nama LIKE ?
                OR e.nik LIKE ?
                OR COALESCE(j.nama_jabatan, '') LIKE ?
                OR COALESCE(jk.nama, '') LIKE ?
                OR COALESCE(s.nama_shift, '') LIKE ?
            )`);
            const likeQ = `%${q}%`;
            employeeParams.push(likeQ, likeQ, likeQ, likeQ, likeQ);
        }
        const employeeWhereSql = employeeWhereClauses.join(' AND ');
        const employees = await db.query(`
            SELECT
                e.id,
                e.nik,
                e.nama,
                e.email,
                e.phone,
                e.status,
                (e.status = 'active') AS is_activated,
                j.nama_jabatan,
                jk.nama AS jadwal_kerja,
                s.nama_shift,
                TIME_FORMAT(s.jam_masuk, '%H:%i') AS shift_masuk,
                TIME_FORMAT(s.jam_keluar, '%H:%i') AS shift_keluar,
                COALESCE(ps.total_presensi, 0) AS total_presensi,
                COALESCE(ps.presensi_hari_ini, 0) AS presensi_hari_ini,
                COALESCE(ps.total_terlambat, 0) AS total_terlambat,
                COALESCE(ab.total_absensi, 0) AS total_absensi,
                COALESCE(ab.absensi_pending, 0) AS absensi_pending
            FROM karyawan e
            LEFT JOIN jabatan j ON j.id = e.id_jabatan
            LEFT JOIN jadwal_kerja jk ON jk.id = e.id_jadwal_kerja
            LEFT JOIN shift s ON s.id = COALESCE(e.shift_id, jk.shift_id)
            LEFT JOIN (
                SELECT
                    id_karyawan,
                    COUNT(*) AS total_presensi,
                    SUM(CASE WHEN tanggal = CURDATE() THEN 1 ELSE 0 END) AS presensi_hari_ini,
                    SUM(CASE WHEN late_minutes > 0 OR status IN ('late', 'terlambat') THEN 1 ELSE 0 END) AS total_terlambat
                FROM presensi
                GROUP BY id_karyawan
            ) ps ON ps.id_karyawan = e.id
            LEFT JOIN (
                SELECT
                    id_karyawan,
                    COUNT(*) AS total_absensi,
                    SUM(CASE WHEN status IN ('pending', 'menunggu_pengganti', 'menunggu_manager') THEN 1 ELSE 0 END) AS absensi_pending
                FROM absensi
                GROUP BY id_karyawan
            ) ab ON ab.id_karyawan = e.id
            WHERE ${employeeWhereSql}
            ORDER BY e.nama ASC
            LIMIT 100
        `, employeeParams);

        res.render('admin/ketidakhadiran/index', {
            title: 'Absensi - Fleur Atelier',
            admin: req.session.admin,
            currentPage: 'absensi',
            requests,
            employees,
            filters: { q },
            pagination,
            messages: {
                success: req.flash('success'),
                error: req.flash('error')
            }
        });
    } catch (error) {
        console.error('Absensi list error:', error);
        res.render('admin/ketidakhadiran/index', {
            title: 'Absensi - Fleur Atelier',
            admin: req.session.admin,
            currentPage: 'absensi',
            requests: [],
            employees: [],
            filters: { q: (req.query.q || '').toString().trim() },
            pagination: getPagination(0, 1, 10),
            messages: {
                success: req.flash('success'),
                error: req.flash('error')
            }
        });
    }
});

// Export Excel: Manajemen Absensi (cuti/izin/sakit)
router.get('/absensi/export', requireAuth, async (req, res) => {
    try {
        const { q } = req.query;
        const whereClauses = ['1=1'];
        const queryParams = [];
        if (q) {
            whereClauses.push(`(e.nama LIKE ? OR e.nik LIKE ? OR lr.jenis LIKE ? OR lr.kategori LIKE ? OR lr.status LIKE ? OR COALESCE(lr.alasan,'') LIKE ?)`);
            const likeQ = `%${q}%`; queryParams.push(likeQ, likeQ, likeQ, likeQ, likeQ, likeQ);
        }
        const whereSql = whereClauses.join(' AND ');

        const requests = await db.query(`
            SELECT lr.jenis, lr.kategori, lr.tanggal_mulai, lr.tanggal_selesai, lr.jam_mulai, lr.jam_selesai,
                   lr.alasan, lr.status, e.nama AS nama_karyawan, e.nik, pengganti.nama AS nama_pengganti
            FROM absensi lr
            JOIN karyawan e ON e.id = lr.id_karyawan
            LEFT JOIN permintaan_absensi pa ON pa.id_absensi = lr.id
            LEFT JOIN karyawan pengganti ON pengganti.id = pa.id_pengganti
            WHERE ${whereSql}
            ORDER BY lr.created_at DESC
        `, queryParams);

        const statusLabel = (s) => ({
            menunggu_pengganti: 'Menunggu Pengganti', ditolak_pengganti: 'Ditolak Pengganti',
            menunggu_manager: 'Menunggu Manager', disetujui: 'Disetujui', ditolak: 'Ditolak', dibatalkan: 'Dibatalkan',
            approved: 'Disetujui', rejected: 'Ditolak', pending: 'Menunggu'
        }[s] || s || '-');
        const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-CA') : '-';

        const columns = [
            { key: 'no', header: 'No', width: 5, align: 'center' },
            { key: 'nik', header: 'NIK', width: 20 },
            { key: 'nama', header: 'Nama', width: 24 },
            { key: 'jenis', header: 'Jenis', width: 10 },
            { key: 'kategori', header: 'Kategori', width: 12 },
            { key: 'mulai', header: 'Tgl Mulai', width: 13, align: 'center' },
            { key: 'selesai', header: 'Tgl Selesai', width: 13, align: 'center' },
            { key: 'alasan', header: 'Alasan', width: 30 },
            { key: 'pengganti', header: 'Pengganti', width: 20 },
            { key: 'status', header: 'Status', width: 18 }
        ];
        const data = requests.map((r, i) => ({
            no: i + 1, nik: r.nik, nama: r.nama_karyawan, jenis: r.jenis, kategori: r.kategori,
            mulai: fmtDate(r.tanggal_mulai), selesai: fmtDate(r.tanggal_selesai), alasan: r.alasan || '-',
            pengganti: r.nama_pengganti || '-', status: statusLabel(r.status)
        }));
        const { generateSimpleExcel } = require('../utils/excel-export');
        const buffer = await generateSimpleExcel({ title: 'Manajemen Absensi (Cuti/Izin/Sakit)', periodLabel: `Diekspor: ${getCurrentDateWITA()}`, columns, rows: data });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="Manajemen_Absensi.xlsx"');
        res.send(buffer);
    } catch (err) {
        console.error('Export absensi error:', err);
        req.flash('error', 'Gagal mengekspor data absensi');
        res.redirect('/admin/absensi');
    }
});

router.get('/absensi/karyawan/:id', requireAuth, async (req, res) => {
    try {
        const employeeId = Number.parseInt(req.params.id, 10);
        if (Number.isNaN(employeeId)) {
            req.flash('error', 'ID karyawan tidak valid');
            return res.redirect('/admin/absensi');
        }

        // Build absensi date filter
        const { page, limit } = getListParams(req, { defaultLimit: 15, maxLimit: 100 });
        const { tanggal, filterType, startDate, endDate, month, year } = req.query;
        let absensiFilter = '';
        const filterParams = [];
        const ft = filterType || 'month';
        if (ft === 'range' && startDate && endDate) {
            absensiFilter = 'AND ((DATE(lr.tanggal_mulai) BETWEEN ? AND ?) OR (DATE(lr.tanggal_selesai) BETWEEN ? AND ?))';
            filterParams.push(startDate, endDate, startDate, endDate);
        } else if (ft === 'month' && month && year) {
            absensiFilter = 'AND ((MONTH(lr.tanggal_mulai) = ? AND YEAR(lr.tanggal_mulai) = ?) OR (MONTH(lr.tanggal_selesai) = ? AND YEAR(lr.tanggal_selesai) = ?))';
            filterParams.push(month, year, month, year);
        } else if (ft === 'year' && year) {
            absensiFilter = 'AND (YEAR(lr.tanggal_mulai) = ? OR YEAR(lr.tanggal_selesai) = ?)';
            filterParams.push(year, year);
        } else if (ft === 'date' && tanggal) {
            absensiFilter = 'AND DATE(lr.tanggal_mulai) <= ? AND DATE(lr.tanggal_selesai) >= ?';
            filterParams.push(tanggal, tanggal);
        } else {
            // Default: bulan berjalan
            const today = new Date();
            const m = today.getMonth() + 1;
            const y = today.getFullYear();
            absensiFilter = 'AND ((MONTH(lr.tanggal_mulai) = ? AND YEAR(lr.tanggal_mulai) = ?) OR (MONTH(lr.tanggal_selesai) = ? AND YEAR(lr.tanggal_selesai) = ?))';
            filterParams.push(m, y, m, y);
        }

        const employeeRows = await db.query(`
            SELECT
                e.id,
                e.nik,
                e.nama,
                e.email,
                e.phone,
                e.status,
                (e.status = 'active') AS is_activated,
                j.nama_jabatan,
                jk.nama AS jadwal_kerja,
                s.nama_shift
            FROM karyawan e
            LEFT JOIN jabatan j ON j.id = e.id_jabatan
            LEFT JOIN jadwal_kerja jk ON jk.id = e.id_jadwal_kerja
            LEFT JOIN shift s ON s.id = e.shift_id
            WHERE e.id = ?
              AND e.deleted_at IS NULL
            LIMIT 1
        `, [employeeId]);

        if (!employeeRows.length) {
            req.flash('error', 'Karyawan tidak ditemukan');
            return res.redirect('/admin/absensi');
        }

        // Summary absensi (filtered by periode)
        const absensiSummaryRows = await db.query(`
            SELECT
                COUNT(*) AS total_absensi,
                SUM(CASE WHEN lr.status IN ('pending', 'menunggu_pengganti', 'menunggu_manager') THEN 1 ELSE 0 END) AS total_pending,
                SUM(CASE WHEN lr.status IN ('approved', 'disetujui') THEN 1 ELSE 0 END) AS total_disetujui,
                SUM(CASE WHEN lr.status IN ('rejected', 'ditolak', 'ditolak_pengganti') THEN 1 ELSE 0 END) AS total_ditolak
            FROM absensi lr
            WHERE lr.id_karyawan = ? ${absensiFilter}
        `, [employeeId, ...filterParams]);

        // Count untuk pagination
        const countAbsRows = await db.query(`
            SELECT COUNT(DISTINCT lr.id) AS total
            FROM absensi lr
            LEFT JOIN permintaan_absensi pa ON pa.id_absensi = lr.id
            WHERE (lr.id_karyawan = ? OR pa.id_pengganti = ?) ${absensiFilter}
        `, [employeeId, employeeId, ...filterParams]);
        const totalAbs = countAbsRows[0]?.total || 0;
        const paginationA = getPagination(totalAbs, page, limit);
        const { safeLimit: safeLimitA, safeOffset: safeOffsetA } = getSafeLimitOffset(paginationA);

        const absensiRows = await db.query(`
            SELECT
                lr.id,
                lr.id_karyawan,
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
                pa.id_pengganti,
                pengganti.nama AS nama_pengganti,
                pa.catatan AS catatan_pengganti,
                CASE WHEN pa.status = 'disetujui' THEN pa.updated_at ELSE NULL END AS approved_pengganti_at,
                lr.approval_notes,
                lr.approval_notes AS rejection_reason,
                lr.approved_at,
                lr.created_at,
                CASE
                    WHEN lr.id_karyawan = ? THEN 'Pengaju'
                    ELSE 'Pengganti'
                END AS relasi,
                CASE
                    WHEN lr.status IN ('approved', 'rejected', 'disetujui', 'ditolak') THEN 'Manager'
                    WHEN lr.status = 'ditolak_pengganti' AND pengganti.nama IS NOT NULL THEN pengganti.nama
                    ELSE '-'
                END AS nama_approver
            FROM absensi lr
            LEFT JOIN permintaan_absensi pa ON pa.id_absensi = lr.id
            LEFT JOIN karyawan pengganti ON pengganti.id = pa.id_pengganti
            WHERE (lr.id_karyawan = ? OR pa.id_pengganti = ?) ${absensiFilter}
            ORDER BY lr.created_at DESC
            LIMIT ${safeLimitA} OFFSET ${safeOffsetA}
        `, [employeeId, employeeId, employeeId, ...filterParams]);

        // Daftar karyawan aktif (+ shift efektif) untuk pilih pengganti pada approve urgent
        const employeeList = await db.query(`
            SELECT e.id, e.nik, e.nama, s.nama_shift,
                   TIME_FORMAT(s.jam_masuk, '%H:%i') AS shift_masuk,
                   TIME_FORMAT(s.jam_keluar, '%H:%i') AS shift_keluar,
                   jk.nama AS jadwal_kerja
            FROM karyawan e
            LEFT JOIN jadwal_kerja jk ON jk.id = e.id_jadwal_kerja
            LEFT JOIN shift s ON s.id = COALESCE(e.shift_id, jk.shift_id)
            WHERE e.status = 'active' AND e.deleted_at IS NULL
            ORDER BY e.nama ASC
        `);

        res.render('admin/absensi/karyawan-detail', {
            title: `Detail Absensi ${employeeRows[0].nama} - Fleur Atelier`,
            admin: req.session.admin,
            currentPage: 'absensi',
            employee: employeeRows[0],
            absensiSummary: absensiSummaryRows[0] || {},
            absensiRows,
            employeeList,
            filters: { filterType: ft, tanggal, startDate, endDate, month, year },
            pagination: paginationA,
            messages: {
                success: req.flash('success'),
                error: req.flash('error')
            }
        });
    } catch (error) {
        console.error('Absensi employee detail error:', error);
        req.flash('error', 'Gagal memuat detail Absensi karyawan');
        return res.redirect('/admin/absensi');
    }
});

router.get('/approval', requireAuth, async (req, res) => {
    if (!isManagerSession(req)) {
        req.flash('error', 'Menu approval khusus manager');
        return res.redirect('/admin/dashboard');
    }
    res.redirect('/admin/absensi');
});

router.post(['/ketidakhadiran/:id/approve', '/absensi/:id/approve'], requireAuth, requireManager, async (req, res) => {
    const { approval_notes } = req.body;
    const approverName = req.session.admin?.username || 'admin';
    const notes = approval_notes || `Disetujui oleh ${isManagerSession(req) ? 'manager' : 'admin'} (${approverName})`;
    const redirectTarget = getSafeAbsensiRedirect(req);

    try {
        const result = await db.query(`
            UPDATE absensi
            SET status = 'disetujui',
                approval_notes = ?,
                approved_at = NOW()
            WHERE id = ?
              AND status IN ('pending', 'menunggu_manager')
        `, [notes, req.params.id]);

        if (!result.affectedRows) {
            req.flash('error', 'Pengajuan sudah diproses akun lain');
            return res.redirect(redirectTarget);
        }

        // Untuk pengajuan URGENT saat approve: manager boleh (1) menyesuaikan JAM (dari-sampai)
        // dan (2) menetapkan pengganti. Dilakukan SEBELUM recompute agar jam terbaru ikut terhitung.
        // Planned tidak terpengaruh (pengganti & jam sudah dari pengaju).
        let extraMsg = '';
        try {
            const leaveRows = await db.query('SELECT id_karyawan, leave_type FROM absensi WHERE id = ? LIMIT 1', [req.params.id]);
            const leave = leaveRows && leaveRows[0];
            if (leave && leave.leave_type === 'urgent') {
                const jamMulai = (req.body.jam_mulai || '').toString().trim();
                const jamSelesai = (req.body.jam_selesai || '').toString().trim();
                if (jamMulai && jamSelesai) {
                    const durasi = menitAntaraJam(jamMulai, jamSelesai);
                    if (durasi > 0) {
                        await db.query(
                            `UPDATE absensi SET jam_mulai = ?, jam_selesai = ?, durasi_menit = ?,
                                 kategori = CASE WHEN kategori = 'full_day' THEN 'hourly' ELSE kategori END
                             WHERE id = ?`,
                            [jamMulai, jamSelesai, durasi, req.params.id]
                        );
                        extraMsg += ' & jam disesuaikan';
                    }
                }
                const idPengganti = Number.parseInt(req.body.id_pengganti, 10);
                if (idPengganti && idPengganti !== Number(leave.id_karyawan)) {
                    const cand = await db.query(`SELECT id FROM karyawan WHERE id = ? AND status = 'active' AND deleted_at IS NULL LIMIT 1`, [idPengganti]);
                    if (cand && cand.length > 0) {
                        const existing = await db.query('SELECT id FROM permintaan_absensi WHERE id_absensi = ? LIMIT 1', [req.params.id]);
                        if (existing && existing.length > 0) {
                            await db.query(`UPDATE permintaan_absensi SET id_pengganti = ?, id_pemohon = ?, status = 'disetujui' WHERE id_absensi = ?`, [idPengganti, leave.id_karyawan, req.params.id]);
                        } else {
                            await db.query(`INSERT INTO permintaan_absensi (id_absensi, id_pengganti, id_pemohon, status) VALUES (?, ?, ?, 'disetujui')`, [req.params.id, idPengganti, leave.id_karyawan]);
                        }
                        extraMsg += ' & pengganti ditetapkan';
                    }
                }
            }
        } catch (e) {
            console.error('Approve urgent extras error:', e.message);
        }

        // Izin bisa disetujui SETELAH karyawan clock-out; hitung ulang presensi terkait.
        try {
            await recalcPresensiForLeave(dbOriginal, req.params.id);
        } catch (recalcErr) {
            console.error('Gagal recompute presensi setelah approve izin:', recalcErr.message);
        }
        // Kreditkan lembur "menggantikan" ke pengganti bila ia sudah terlanjur clock-out.
        try {
            const devToday = isDevScheduleBypassEnabled() ? getCurrentDateWITA() : null;
            await recalcSubstitutePresensiForLeave(dbOriginal, req.params.id, devToday);
        } catch (subErr) {
            console.error('Gagal recompute presensi pengganti setelah approve:', subErr.message);
        }

        req.flash('success', `Pengajuan berhasil disetujui${extraMsg}`);
        res.redirect(redirectTarget);
    } catch (error) {
        console.error('Approve absensi error:', error);
        req.flash('error', 'Gagal menyetujui pengajuan');
        res.redirect(redirectTarget);
    }
});

router.post(['/ketidakhadiran/:id/reject', '/absensi/:id/reject'], requireAuth, requireManager, async (req, res) => {
    const { rejection_reason } = req.body;
    const approverName = req.session.admin?.username || 'admin';
    const alasan = rejection_reason || `Pengajuan ditolak oleh ${isManagerSession(req) ? 'manager' : 'admin'} (${approverName})`;
    const redirectTarget = getSafeAbsensiRedirect(req);

    try {
        const result = await db.query(`
            UPDATE absensi
            SET status = 'ditolak',
                approval_notes = ?,
                approved_at = NOW()
            WHERE id = ?
              AND status IN ('pending', 'menunggu_manager')
        `, [alasan, req.params.id]);

        if (!result.affectedRows) {
            req.flash('error', 'Pengajuan sudah diproses akun lain');
            return res.redirect(redirectTarget);
        }

        req.flash('success', 'Pengajuan berhasil ditolak');
        res.redirect(redirectTarget);
    } catch (error) {
        console.error('Reject absensi error:', error);
        req.flash('error', 'Gagal menolak pengajuan');
        res.redirect(redirectTarget);
    }
});

// Manager menentukan pengganti untuk pengajuan URGENT yang sudah disetujui.
// Business rule: hanya Manager yang boleh menentukan pengganti pada Urgent Leave, dan hanya
// setelah pengajuan disetujui. Lembur pengganti dihitung utils/worktime.js: jam menutupi
// (window cover, dari jam yang ditetapkan manager / shift orang yang digantikan) yang berada
// DI LUAR shift pengganti sendiri diakui sebagai lembur (>= 1 jam); bagian yang beririsan
// dengan shift sendiri tetap jam kerja biasa (tidak dobel).
router.post(['/absensi/:id/assign-pengganti', '/ketidakhadiran/:id/assign-pengganti'], requireAuth, requireManager, async (req, res) => {
    const redirectTarget = getSafeAbsensiRedirect(req);
    const idPengganti = Number.parseInt(req.body.id_pengganti, 10);
    const catatan = req.body.catatan || null;

    try {
        const leaveRows = await db.query(
            `SELECT id, id_karyawan, leave_type, status FROM absensi WHERE id = ? LIMIT 1`,
            [req.params.id]
        );
        const leave = leaveRows && leaveRows[0];
        if (!leave) {
            req.flash('error', 'Pengajuan tidak ditemukan');
            return res.redirect(redirectTarget);
        }
        if (leave.leave_type !== 'urgent') {
            req.flash('error', 'Penentuan pengganti oleh manager hanya untuk pengajuan Urgent');
            return res.redirect(redirectTarget);
        }
        if (leave.status !== 'disetujui') {
            req.flash('error', 'Setujui pengajuan terlebih dahulu sebelum menentukan pengganti');
            return res.redirect(redirectTarget);
        }
        if (!idPengganti || idPengganti === Number(leave.id_karyawan)) {
            req.flash('error', 'Pengganti tidak valid (kosong atau sama dengan pemohon)');
            return res.redirect(redirectTarget);
        }

        const candidate = await db.query(
            `SELECT id FROM karyawan WHERE id = ? AND status = 'active' AND deleted_at IS NULL LIMIT 1`,
            [idPengganti]
        );
        if (!candidate || candidate.length === 0) {
            req.flash('error', 'Karyawan pengganti tidak ditemukan atau tidak aktif');
            return res.redirect(redirectTarget);
        }

        // Jam pengganti (dari-sampai) bila diisi manager: perbarui jam absensi + durasi.
        const jamMulai = (req.body.jam_mulai || '').toString().trim();
        const jamSelesai = (req.body.jam_selesai || '').toString().trim();
        if (jamMulai && jamSelesai) {
            const durasi = menitAntaraJam(jamMulai, jamSelesai);
            if (durasi > 0) {
                await db.query(
                    `UPDATE absensi SET jam_mulai = ?, jam_selesai = ?, durasi_menit = ?,
                         kategori = CASE WHEN kategori = 'full_day' THEN 'hourly' ELSE kategori END
                     WHERE id = ?`,
                    [jamMulai, jamSelesai, durasi, req.params.id]
                );
            }
        }

        // Upsert baris pengganti. Untuk urgent, status langsung 'disetujui' (ditetapkan manager,
        // tidak perlu persetujuan pengganti). Integrasi absen-pengganti yang sudah ada memakai
        // permintaan_absensi berstatus 'disetujui', jadi otomatis nyambung.
        const existing = await db.query(
            `SELECT id FROM permintaan_absensi WHERE id_absensi = ? LIMIT 1`,
            [req.params.id]
        );
        if (existing && existing.length > 0) {
            await db.query(
                `UPDATE permintaan_absensi
                 SET id_pengganti = ?, id_pemohon = ?, status = 'disetujui', catatan = COALESCE(?, catatan)
                 WHERE id_absensi = ?`,
                [idPengganti, leave.id_karyawan, catatan, req.params.id]
            );
        } else {
            await db.query(
                `INSERT INTO permintaan_absensi (id_absensi, id_pengganti, id_pemohon, status, catatan)
                 VALUES (?, ?, ?, 'disetujui', ?)`,
                [req.params.id, idPengganti, leave.id_karyawan, catatan]
            );
        }

        // Bila pengganti sudah terlanjur clock-out, kreditkan lembur "menggantikan" sekarang.
        try {
            const devToday = isDevScheduleBypassEnabled() ? getCurrentDateWITA() : null;
            await recalcSubstitutePresensiForLeave(dbOriginal, req.params.id, devToday);
        } catch (subErr) {
            console.error('Gagal recompute presensi pengganti setelah assign:', subErr.message);
        }

        req.flash('success', 'Pengganti berhasil ditentukan untuk pengajuan urgent');
        res.redirect(redirectTarget);
    } catch (error) {
        console.error('Assign pengganti (urgent) error:', error);
        req.flash('error', 'Gagal menentukan pengganti');
        res.redirect(redirectTarget);
    }
});

// ===== Data Pengujian Face Recognition (BAHAN LAPORAN saja) =====
// DINAMIS: menarik data yang benar-benar ada di basis data (karyawan + foto referensi
// wajah yang dipakai pembanding + info encoding). Tanpa migrasi/tabel baru. Filter, pilih,
// hapus, dan export Excel dilakukan di sisi klien (browser). Halaman berdiri sendiri —
// tidak mengubah tampilan/menu yang sudah ada. Data hanya ditampilkan, tidak diubah.
router.get('/testing', requireAuth, requireSuperAdmin, async (req, res) => {
    // Data pengujian = absen BERHASIL (presensi) + percobaan GAGAL (face_attempt_log).
    try {
        const parse = (v) => { try { return typeof v === 'string' ? JSON.parse(v || '{}') : (v || {}); } catch (e) { return {}; } };
        const events = [];

        // 1) Absen BERHASIL (foto probe + kemiripan) dari presensi
        const presensiRows = await db.query(`
            SELECT p.id,
                   DATE_FORMAT(p.tanggal, '%d-%m-%Y') AS tgl,
                   DATE_FORMAT(p.tanggal, '%Y-%m-%d') AS tgl_iso,
                   TIME_FORMAT(p.jam_masuk, '%H:%i') AS jam_masuk,
                   TIME_FORMAT(p.jam_keluar, '%H:%i') AS jam_keluar,
                   p.data_masuk, p.data_keluar, k.nik, k.nama
            FROM presensi p
            LEFT JOIN karyawan k ON k.id = p.id_karyawan
            ORDER BY p.tanggal DESC, p.id DESC`, []);
        (presensiRows || []).forEach((p) => {
            const dm = parse(p.data_masuk), dk = parse(p.data_keluar);
            if (dm && dm.foto) events.push({
                source: 'presensi', pid: p.id, type: 'masuk', jenisLabel: 'Check-in',
                nik: p.nik || '-', nama: p.nama || '-', tgl: p.tgl || '-', jam: p.jam_masuk || '-',
                sortKey: (p.tgl_iso || '') + ' ' + (p.jam_masuk || '00:00'),
                hasil: 'berhasil', similarity: dm.face_similarity, jarak: dm.jarak_meter,
                keterangan: 'Cocok dengan referensi'
            });
            if (dk && dk.foto) events.push({
                source: 'presensi', pid: p.id, type: 'keluar', jenisLabel: 'Check-out',
                nik: p.nik || '-', nama: p.nama || '-', tgl: p.tgl || '-', jam: p.jam_keluar || '-',
                sortKey: (p.tgl_iso || '') + ' ' + (p.jam_keluar || '00:00'),
                hasil: 'berhasil', similarity: dk.face_similarity, jarak: dk.jarak_meter,
                keterangan: 'Cocok dengan referensi'
            });
        });

        // 1b) Selesai ISTIRAHAT yang BERHASIL (dari data_masuk.istirahat.sesi[])
        (presensiRows || []).forEach((p) => {
            const dm = parse(p.data_masuk);
            const sesi = (dm && dm.istirahat && Array.isArray(dm.istirahat.sesi)) ? dm.istirahat.sesi : [];
            sesi.forEach((s, sidx) => {
                if (!s || !s.foto || !s.selesai) return;
                const waktu = String(s.selesai || '');       // 'YYYY-MM-DD HH:MM:SS'
                const tglIso = waktu.slice(0, 10);
                const jam = waktu.slice(11, 16);
                const parts = tglIso.split('-');
                const tgl = (parts.length === 3) ? (parts[2] + '-' + parts[1] + '-' + parts[0]) : (p.tgl || '-');
                events.push({
                    source: 'break', pid: p.id, sidx: sidx, type: 'istirahat', jenisLabel: 'Selesai istirahat',
                    nik: p.nik || '-', nama: p.nama || '-', tgl: tgl || p.tgl || '-', jam: jam || '-',
                    sortKey: (tglIso || p.tgl_iso || '') + ' ' + (jam || '00:00'),
                    hasil: 'berhasil', similarity: s.face_similarity,
                    jarak: (s.lokasi_selesai && s.lokasi_selesai.jarak_meter != null) ? s.lokasi_selesai.jarak_meter : null,
                    keterangan: 'Cocok dengan referensi'
                });
            });
        });

        // 2) Percobaan GAGAL dari kolom JSON karyawan.data_percobaan_gagal
        let karyawanGagal = [];
        try {
            karyawanGagal = await db.query(
                `SELECT id, nik, nama, data_percobaan_gagal
                 FROM karyawan
                 WHERE data_percobaan_gagal IS NOT NULL`, []);
        } catch (e) {
            console.warn('kolom data_percobaan_gagal belum tersedia:', e.message);
        }
        const jenisLabelMap = { masuk: 'Check-in', keluar: 'Check-out', istirahat: 'Selesai istirahat' };
        (karyawanGagal || []).forEach((k) => {
            const arr = parse(k.data_percobaan_gagal);
            const list = Array.isArray(arr) ? arr : [];
            list.forEach((a, idx) => {
                const waktu = String(a.waktu || '');            // 'YYYY-MM-DD HH:MM:SS'
                const tglIso = waktu.slice(0, 10);
                const jam = waktu.slice(11, 16);
                const p = tglIso.split('-');
                const tgl = (p.length === 3) ? (p[2] + '-' + p[1] + '-' + p[0]) : (tglIso || '-');
                events.push({
                    source: 'attempt', kid: k.id, idx: idx, jenis: a.jenis, failType: a.status,
                    jenisLabel: jenisLabelMap[a.jenis] || a.jenis,
                    nik: k.nik || '-', nama: k.nama || '(tidak dikenal)',
                    tgl: tgl || '-', jam: jam || '-',
                    sortKey: (tglIso || '') + ' ' + (jam || '00:00'),
                    hasil: 'gagal', similarity: a.similarity, jarak: null,
                    hasPhoto: Boolean(a.foto), keterangan: a.keterangan || 'Gagal'
                });
            });
        });

        // Gabungkan, urutkan waktu terbaru dulu
        events.sort((x, y) => String(y.sortKey || '').localeCompare(String(x.sortKey || '')));

        // 3) Wajah REFERENSI (yang dipakai pembanding) untuk tab Referensi
        let references = [];
        try {
            const refRows = await db.query(`
                SELECT fr.id AS rid, fr.enrollment_method AS method,
                       DATE_FORMAT(fr.created_at, '%d-%m-%Y %H:%i') AS dibuat,
                       k.nik, k.nama
                FROM karyawan_face_reference fr
                LEFT JOIN karyawan k ON k.id = fr.id_karyawan
                WHERE fr.is_active = TRUE
                ORDER BY k.nama ASC, fr.id ASC`, []);
            references = (refRows || []).map(r => ({
                rid: r.rid, nik: r.nik || '-', nama: r.nama || '-',
                method: r.method || '-', dibuat: r.dibuat || '-'
            }));
        } catch (e) {
            console.warn('query referensi gagal:', e.message);
        }

        let karyawanList = [];
        try {
            karyawanList = await db.query(
                `SELECT id, nik, nama FROM karyawan WHERE deleted_at IS NULL ORDER BY nama ASC`
            );
        } catch (e) {
            console.warn('query karyawan (testing) gagal:', e.message);
        }

        res.render('admin/testing', {
            title: 'Data Pengujian Face Recognition - Fleur Atelier',
            events,
            references,
            karyawanList
        });
    } catch (err) {
        console.error('Testing query error:', err);
        return res.status(500).send('Gagal memuat data pengujian');
    }
});

// Thumbnail wajah dari FOTO ABSEN (probe): pakai detektor wajah CNN (face-api) yang sama
// dengan proses encoding -> ambil kotak wajah, ZOOM ke wajah + gambar KOTAK deteksi. Cache.
// Reset presensi (alat DEMO/uji, superadmin). Menghapus baris presensi seorang karyawan pada
// tanggal tertentu (default: hari ini WITA) supaya karyawan bisa clock-in ulang dari nol untuk
// keperluan demo. Aturan 1-presensi/hari & laporan tetap utuh — ini hanya menghapus SATU baris
// yang dipilih superadmin secara eksplisit, bukan mengubah logika inti.
router.post('/testing/presensi/reset', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        const idKaryawan = Number.parseInt(req.body.id_karyawan, 10);
        const tanggal = (req.body.tanggal && String(req.body.tanggal).trim()) || getCurrentDateWITA();
        if (!idKaryawan) {
            req.flash('error', 'Pilih karyawan yang presensinya akan direset');
            return res.redirect('/admin/testing');
        }
        const result = await db.query(
            `DELETE FROM presensi WHERE id_karyawan = ? AND tanggal = ?`,
            [idKaryawan, tanggal]
        );
        if (result.affectedRows > 0) {
            req.flash('success', `Presensi ${tanggal} untuk karyawan #${idKaryawan} direset (${result.affectedRows} baris terhapus). Karyawan bisa clock-in ulang.`);
        } else {
            req.flash('error', `Tidak ada presensi tanggal ${tanggal} untuk karyawan #${idKaryawan} (mungkin memang sudah kosong).`);
        }
        res.redirect('/admin/testing');
    } catch (error) {
        console.error('Reset presensi (demo) error:', error);
        req.flash('error', 'Gagal reset presensi');
        res.redirect('/admin/testing');
    }
});

// Pipeline stage: serve gambar tahapan face recognition (bbox / align / encode / match).
// Gunakan cache per stage + photo agar tiap stage hasilnya diskal.
async function servePipelineStage(res, photoPath, cacheKeyBase, stage, extra) {
    const sharp = require('sharp');
    if (!photoPath) return res.status(404).end();
    if (/^https?:\/\//.test(photoPath)) return res.redirect(photoPath);
    const src = [path.join(__dirname, '..', 'public', photoPath), path.join(__dirname, '..', photoPath)]
        .find(p => fs.existsSync(p));
    if (!src) return res.status(404).end();
    const cacheDir = path.join(__dirname, '..', 'public', 'uploads', 'faces-crop');
    const cacheFile = path.join(cacheDir, cacheKeyBase + '-' + (stage || 'thumb') + '.jpg');
    try {
        if (fs.existsSync(cacheFile)) {
            res.setHeader('Cache-Control', 'public, max-age=86400');
            return res.sendFile(cacheFile);
        }
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

        let out = null;

        if (!stage) {
            // Thumbnail ringan: resize saja, TANPA face detection (hemat CPU/RAM)
            out = await sharp(src).rotate().resize(220, 220, { fit: 'cover', position: 'attention' }).jpeg({ quality: 80 }).toBuffer();
        } else if (stage === 'align') {
            const { drawFaceLandmarks } = require('../utils/face-recognition');
            out = await drawFaceLandmarks(src);
            out = await sharp(out).resize(720, 720, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
        } else if (stage === 'encode') {
            const { detectFaces, generateEncodingChart } = require('../utils/face-recognition');
            const faces = await detectFaces(src);
            if (faces && faces.length > 0 && faces[0].descriptor) {
                out = await generateEncodingChart(faces[0].descriptor);
            } else {
                const { createCanvas } = require('canvas');
                const cv = createCanvas(500, 150);
                const ctx = cv.getContext('2d');
                ctx.fillStyle = '#ef4444';
                ctx.font = '16px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('Encoding gagal — wajah tidak terdeteksi', 250, 75);
                out = cv.toBuffer('image/jpeg', { quality: 0.9 });
            }
        } else if (stage === 'match' && extra) {
            // Pencocokan wajah: side-by-side probe vs referensi
            const refPath = [path.join(__dirname, '..', 'public', extra.refPhoto), path.join(__dirname, '..', extra.refPhoto)]
                .find(p => fs.existsSync(p));
            const { createCanvas, loadImage } = require('canvas');
            const probeBuf = await sharp(src).rotate().resize(360, 360, { fit: 'cover', position: 'attention' }).jpeg({ quality: 90 }).toBuffer();
            const probeImg = await loadImage(probeBuf);
            let refImg = null;
            if (refPath) {
                const refBuf = await sharp(refPath).rotate().resize(360, 360, { fit: 'cover', position: 'attention' }).jpeg({ quality: 90 }).toBuffer();
                refImg = await loadImage(refBuf);
            }
            const gap = 24;
            const labelH = 60;
            const w = 360 + (refImg ? gap + 360 : 0);
            const h = 360 + labelH;
            const cv = createCanvas(w, h);
            const ctx = cv.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(probeImg, 0, 0, 360, 360);
            ctx.fillStyle = '#1a56b0';
            ctx.font = 'bold 14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Foto Probe (Absen)', 180, 378);
            if (refImg) {
                ctx.drawImage(refImg, 360 + gap, 0, 360, 360);
                ctx.fillStyle = '#0a7d2c';
                ctx.fillText('Foto Referensi (Enrollment)', 360 + gap + 180, 378);
            }
            // Skor kemiripan + jarak
            const infoY = refImg ? 405 : 395;
            ctx.fillStyle = '#333';
            ctx.font = '13px sans-serif';
            const simStr = extra.similarity != null ? (Math.round(Number(extra.similarity) * 1000) / 10).toString().replace('.', ',') + '%' : '-';
            const distStr = extra.distance != null ? Number(extra.distance).toFixed(4) : '-';
            const thresholdStr = extra.threshold != null ? Number(extra.threshold).toFixed(2) : '0.60';
            const matchStr = extra.isMatch ? 'COCOK' : 'TIDAK COCOK';
            const matchClr = extra.isMatch ? '#0a7d2c' : '#b00020';
            ctx.fillText(`Kemiripan: ${simStr}  |  Jarak Euclidean: ${distStr}  |  Ambang: ${thresholdStr}  |`, w / 2, infoY);
            ctx.fillStyle = matchClr;
            ctx.font = 'bold 14px sans-serif';
            ctx.fillText(`Status: ${matchStr}`, w / 2, infoY + 18);
            out = cv.toBuffer('image/jpeg', { quality: 0.92 });
        } else if (stage === 'bbox') {
            // Bounding box: crop wajah + kotak (face detection jalan di sini)
            const { detectFaces } = require('../utils/face-recognition');
            try {
                const { createCanvas, loadImage } = require('canvas');
                const faces = await detectFaces(src);
                if (faces && faces.length && faces[0].box) {
                    const box = faces[0].box;
                    const orientedBuf = await sharp(src).rotate().toBuffer();
                    const img = await loadImage(orientedBuf);
                    const cx = (box.xMin + box.xMax) / 2, cy = (box.yMin + box.yMax) / 2;
                    let side = Math.round(Math.max(box.width, box.height) * 1.35);
                    side = Math.max(1, Math.min(side, img.width, img.height));
                    const left = Math.max(0, Math.min(Math.round(cx - side / 2), img.width - side));
                    const top = Math.max(0, Math.min(Math.round(cy - side / 2), img.height - side));
                    const canvas = createCanvas(side, side);
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, left, top, side, side, 0, 0, side, side);
                    ctx.strokeStyle = '#22c55e';
                    ctx.lineWidth = Math.max(3, Math.round(side * 0.012));
                    ctx.strokeRect(box.xMin - left, box.yMin - top, box.width, box.height);
                    const drawn = canvas.toBuffer('image/jpeg', { quality: 0.92 });
                    const target = Math.min(side, 512);
                    out = await sharp(drawn).resize(target, target, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
                }
            } catch (e) { console.warn('bbox draw gagal:', e.message); }
            if (!out) {
                out = await sharp(src).rotate().resize(480, 480, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
            }
        }

        fs.writeFileSync(cacheFile, out);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.send(out);
    } catch (e) {
        console.error('servePipelineStage error:', e.message);
        try { return res.sendFile(src); } catch (_) { return res.status(404).end(); }
    }
}

// ==================== ROUTE GAMBAR FACE RECOGNITION (THUMBNAIL + PIPELINE) ====================
// Semua route: GET /admin/testing/probe|attempt|istirahat|reference/:params
// Support query ?stage=bbox|align|encode|match  untuk visualisasi pipeline

// Foto probe (absen berhasil: check-in / check-out) — id_karyawan cuma di-fetch untuk stage match
router.get('/testing/probe/:pid/:type', requireAuth, requireSuperAdmin, async (req, res) => {
    const pid = parseInt(req.params.pid, 10);
    const type = req.params.type === 'keluar' ? 'keluar' : 'masuk';
    const stage = req.query.stage || '';
    if (!pid) return res.status(400).end();
    try {
        let rows;
        if (stage === 'match') {
            rows = await db.query('SELECT data_' + type + ' AS d, id_karyawan FROM presensi WHERE id = ?', [pid]);
        } else {
            rows = await db.query('SELECT data_' + type + ' AS d FROM presensi WHERE id = ?', [pid]);
        }
        if (!rows || !rows.length) return res.status(404).end();
        let data = {};
        try { data = typeof rows[0].d === 'string' ? JSON.parse(rows[0].d || '{}') : (rows[0].d || {}); } catch (e) {}
        const photoPath = data && data.foto;
        const cacheKey = 'probe-' + pid + '-' + type;
        let extra = null;
        if (stage === 'match' && rows[0].id_karyawan) {
            const refRows = await db.query(
                'SELECT photo_path FROM karyawan_face_reference WHERE id_karyawan = ? AND is_active = TRUE LIMIT 1',
                [rows[0].id_karyawan]
            );
            extra = {
                refPhoto: (refRows && refRows.length) ? refRows[0].photo_path : null,
                similarity: data.face_similarity || null,
                distance: data.face_similarity != null ? (1 - Number(data.face_similarity)) : null,
                threshold: (1 - Number(process.env.FACE_MATCH_DISTANCE || '0.6')),
                isMatch: data.face_similarity != null ? (Number(data.face_similarity) >= (1 - Number(process.env.FACE_MATCH_DISTANCE || '0.6'))) : false
            };
        }
        return servePipelineStage(res, photoPath, cacheKey, stage, extra);
    } catch (e) {
        console.error('Probe route error:', e.message);
        return res.status(404).end();
    }
});

// Foto percobaan GAGAL (no_match / no_face / no_image)
router.get('/testing/attempt/:kid/:idx', requireAuth, requireSuperAdmin, async (req, res) => {
    const kid = parseInt(req.params.kid, 10);
    const idx = parseInt(req.params.idx, 10);
    const stage = req.query.stage || '';
    if (!kid || Number.isNaN(idx)) return res.status(400).end();
    try {
        const rows = await db.query('SELECT data_percobaan_gagal FROM karyawan WHERE id = ?', [kid]);
        if (!rows || !rows.length) return res.status(404).end();
        let arr = rows[0].data_percobaan_gagal;
        if (typeof arr === 'string') { try { arr = JSON.parse(arr || '[]'); } catch (e) { arr = []; } }
        if (!Array.isArray(arr) || !arr[idx]) return res.status(404).end();
        const photoPath = arr[idx].foto;
        const cacheKey = 'attempt-' + kid + '-' + idx;
        let extra = null;
        if (stage === 'match') {
            const refRows = await db.query(
                'SELECT photo_path FROM karyawan_face_reference WHERE id_karyawan = ? AND is_active = TRUE LIMIT 1',
                [kid]
            );
            const similarity = arr[idx].similarity;
            extra = {
                refPhoto: (refRows && refRows.length) ? refRows[0].photo_path : null,
                similarity: similarity || null,
                distance: similarity != null ? (1 - Number(similarity)) : null,
                threshold: (1 - Number(process.env.FACE_MATCH_DISTANCE || '0.6')),
                isMatch: false // attempt route = selalu gagal
            };
        }
        return servePipelineStage(res, photoPath, cacheKey, stage, extra);
    } catch (e) {
        console.error('Attempt route error:', e.message);
        return res.status(404).end();
    }
});

// Foto selesai istirahat yang berhasil
router.get('/testing/istirahat/:pid/:sidx', requireAuth, requireSuperAdmin, async (req, res) => {
    const pid = parseInt(req.params.pid, 10);
    const sidx = parseInt(req.params.sidx, 10);
    const stage = req.query.stage || '';
    if (!pid || Number.isNaN(sidx)) return res.status(400).end();
    try {
        const rows = await db.query('SELECT data_masuk FROM presensi WHERE id = ?', [pid]);
        if (!rows || !rows.length) return res.status(404).end();
        let dm = rows[0].data_masuk;
        if (typeof dm === 'string') { try { dm = JSON.parse(dm || '{}'); } catch (e) { dm = {}; } }
        const sesi = (dm && dm.istirahat && Array.isArray(dm.istirahat.sesi)) ? dm.istirahat.sesi : [];
        const photoPath = sesi[sidx] && sesi[sidx].foto;
        const cacheKey = 'break-' + pid + '-' + sidx;
        let extra = null;
        if (stage === 'match') {
            const presensiRows = await db.query('SELECT id_karyawan FROM presensi WHERE id = ?', [pid]);
            if (presensiRows && presensiRows.length) {
                const refRows = await db.query(
                    'SELECT photo_path FROM karyawan_face_reference WHERE id_karyawan = ? AND is_active = TRUE LIMIT 1',
                    [presensiRows[0].id_karyawan]
                );
                const sim = sesi[sidx] && sesi[sidx].face_similarity;
                extra = {
                    refPhoto: (refRows && refRows.length) ? refRows[0].photo_path : null,
                    similarity: sim || null,
                    distance: sim != null ? (1 - Number(sim)) : null,
                    threshold: (1 - Number(process.env.FACE_MATCH_DISTANCE || '0.6')),
                    isMatch: sim != null ? (Number(sim) >= (1 - Number(process.env.FACE_MATCH_DISTANCE || '0.6'))) : false
                };
            }
        }
        return servePipelineStage(res, photoPath, cacheKey, stage, extra);
    } catch (e) {
        console.error('Istirahat route error:', e.message);
        return res.status(404).end();
    }
});

// Foto wajah referensi (enrollment)
router.get('/testing/reference/:rid', requireAuth, requireSuperAdmin, async (req, res) => {
    const rid = parseInt(req.params.rid, 10);
    const stage = req.query.stage || '';
    if (!rid) return res.status(400).end();
    try {
        const rows = await db.query('SELECT photo_path FROM karyawan_face_reference WHERE id = ?', [rid]);
        if (!rows || !rows.length) return res.status(404).end();
        return servePipelineStage(res, rows[0].photo_path, 'ref-' + rid, stage, null);
    } catch (e) {
        console.error('Reference route error:', e.message);
        return res.status(404).end();
    }
});

module.exports = router;
