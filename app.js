const express = require('express');
const cors = require('cors');
const session = require('express-session');
const flash = require('express-flash');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
require('./config/env')();
const { verifyEmailTransport, isEmailConfigured } = require('./utils/email-verification');
const { runMigrations } = require('./scripts/migrate');
const createMySqlSessionStore = require('./utils/mysql-session-store');
const { getMysqlBaseConfig, getMysqlConfig } = require('./config/mysql');
const { isBlobStorageEnabled } = require('./utils/upload-storage');

// Set timezone to WITA (UTC+8) - Fixed timezone, tidak bergantung env
process.env.TZ = 'Asia/Makassar';

// Suppress deprecation warnings
process.noDeprecation = true;

// Handle deprecation warnings
process.on('warning', (warning) => {
    if (warning.name === 'DeprecationWarning' && warning.message.includes('util.isArray')) {
        // Silently ignore util.isArray deprecation warnings
        return;
    }
    // Log other warnings
    console.warn(warning.name, warning.message);
});

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DB_HOST = process.env.DB_HOST;
const DB_USER = process.env.DB_USER;
const DB_PASS = process.env.DB_PASS;
const DB_NAME = process.env.DB_NAME;
const DB_PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined;

function escapeDbIdentifier(identifier) {
    return `\`${String(identifier).replace(/`/g, '``')}\``;
}

async function cleanupLegacyKaryawanSchema(connection) {
    const [managerColumnRows] = await connection.execute(
        `SELECT 1
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'karyawan'
           AND COLUMN_NAME = 'manager_id'
         LIMIT 1`
    );

    if (!managerColumnRows.length) {
        return;
    }

    const [fkRows] = await connection.execute(
        `SELECT CONSTRAINT_NAME
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'karyawan'
           AND COLUMN_NAME = 'manager_id'
           AND REFERENCED_TABLE_NAME IS NOT NULL`
    );

    for (const row of fkRows) {
        await connection.execute(`ALTER TABLE karyawan DROP FOREIGN KEY ${escapeDbIdentifier(row.CONSTRAINT_NAME)}`);
    }

    await connection.execute('ALTER TABLE karyawan DROP COLUMN manager_id');
    console.log('Skema legacy dibersihkan: kolom karyawan.manager_id dihapus.');
}

async function ensureDatabaseReady() {
    if (!DB_HOST || !DB_USER || !DB_NAME) {
        throw new Error('DB_HOST, DB_USER, dan DB_NAME wajib diisi di .env');
    }

    const baseDbConfig = getMysqlBaseConfig();

    async function openDatabaseConnection() {
        return mysql.createConnection(getMysqlConfig());
    }

    let dbConnection;

    try {
        dbConnection = await openDatabaseConnection();
    } catch (error) {
        if (error.code !== 'ER_BAD_DB_ERROR') {
            throw error;
        }

        console.warn(`Database '${DB_NAME}' belum ada. Mencoba membuat database...`);
        const bootstrapConnection = await mysql.createConnection(baseDbConfig);

        try {
            await bootstrapConnection.execute(`CREATE DATABASE IF NOT EXISTS ${escapeDbIdentifier(DB_NAME)}`);
        } finally {
            await bootstrapConnection.end();
        }

        dbConnection = await openDatabaseConnection();
    }

    let shouldRunMigration = false;

    try {
        const [coreTables] = await dbConnection.execute(
            `SELECT TABLE_NAME
             FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME IN ('user', 'karyawan', 'presensi')
             LIMIT 3`
        );

        shouldRunMigration = coreTables.length < 3;

        if (!shouldRunMigration) {
            await cleanupLegacyKaryawanSchema(dbConnection);
        }
    } finally {
        await dbConnection.end();
    }

    if (shouldRunMigration) {
        console.log('Database belum siap. Menjalankan migrasi awal...');
        await runMigrations();
        console.log('Migrasi awal selesai.');
    } else {
        console.log('Database sudah siap. Lewati migrasi awal.');
    }
}

// Environment configuration
const rawNodeEnv = process.env.NODE_ENV || 'development';
const isVercel = process.env.VERCEL === '1';
const isProduction = rawNodeEnv === 'production';
let productionConfigError = null;
const parsedMaxAge = Number(process.env.SESSION_MAX_AGE_MS || (24 * 60 * 60 * 1000));
const sessionSecret = process.env.SESSION_SECRET;
const jwtSecret = process.env.JWT_SECRET;
const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET;
const appBaseUrl = process.env.APP_BASE_URL || '';
const configuredOrigins = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
let allowedOrigins = configuredOrigins;

if (isProduction && allowedOrigins.includes('*')) {
    allowedOrigins = appBaseUrl ? [appBaseUrl] : [];
    console.warn('CORS_ORIGIN="*" is not allowed in production. Falling back to APP_BASE_URL.');
} else if (isProduction && !allowedOrigins.length && appBaseUrl) {
    allowedOrigins = [appBaseUrl];
}

function isLocalUrl(value) {
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(value || '');
}

function assertMinSecretLength(name, value) {
    if (!value || value.length < 32) {
        throw new Error(`${name} must be set to at least 32 characters in production`);
    }
}

function validateProductionConfig() {
    if (!isProduction) {
        return;
    }

    const missing = [];
    if (!DB_HOST) missing.push('DB_HOST');
    if (!DB_USER) missing.push('DB_USER');
    if (!DB_NAME) missing.push('DB_NAME');
    if (!sessionSecret) missing.push('SESSION_SECRET');
    if (!jwtSecret) missing.push('JWT_SECRET');
    if (!jwtRefreshSecret) missing.push('JWT_REFRESH_SECRET');
    if (!appBaseUrl) missing.push('APP_BASE_URL');
    if (!allowedOrigins.length) missing.push('CORS_ORIGIN');

    if (missing.length) {
        throw new Error(`Missing production environment variables: ${missing.join(', ')}`);
    }

    assertMinSecretLength('SESSION_SECRET', sessionSecret);
    assertMinSecretLength('JWT_SECRET', jwtSecret);
    assertMinSecretLength('JWT_REFRESH_SECRET', jwtRefreshSecret);

    if (isLocalUrl(appBaseUrl) || !appBaseUrl.startsWith('https://')) {
        throw new Error('APP_BASE_URL must be the public HTTPS URL in production');
    }
}

try {
    validateProductionConfig();
} catch (error) {
    productionConfigError = error.message;
    if (!isVercel) {
        throw error;
    }
    console.error('Production configuration warning:', error.message);
}

if (!sessionSecret) {
    if (isProduction && !isVercel) {
        throw new Error('SESSION_SECRET must be set in production');
    }
    console.warn('SESSION_SECRET is not set. Using temporary development secret.');
}

if (!jwtSecret && isProduction && !isVercel) {
    throw new Error('JWT_SECRET must be set in production');
}

if (!jwtRefreshSecret && isProduction && !isVercel) {
    throw new Error('JWT_REFRESH_SECRET must be set in production');
}

// Import routes
const adminRoutes = require('./routes/admin');
const apiRoutes = require('./routes/api');
const { checkDatabaseConnection } = require('./routes/api');
const { serve, setup } = require('./swagger');

app.disable('x-powered-by');

if (isProduction) {
    app.set('trust proxy', 1);
}

// Middleware
app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true
}));

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self)');
    if (isProduction) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});

app.use(express.json({ 
    limit: process.env.MAX_FILE_SIZE || '5mb' 
}));
app.use(express.urlencoded({ 
    extended: true,
    limit: process.env.MAX_FILE_SIZE || '5mb'
}));
app.use(express.static('public'));
// Serve uploads folder for images
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Session configuration
const sessionStore = isProduction
    ? createMySqlSessionStore(session, getMysqlConfig())
    : undefined;

const sessionOptions = {
    secret: sessionSecret || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: isProduction,
        sameSite: isProduction ? 'strict' : 'lax',
        maxAge: parsedMaxAge,
        httpOnly: true
    },
    name: 'fleur.session.id' // Custom session name
};

if (sessionStore) {
    sessionOptions.store = sessionStore;
}

app.use(session(sessionOptions));

app.use(flash());

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Pass environment variables ke semua views
app.locals.GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// Routes
app.use('/admin', adminRoutes);
app.use('/api', apiRoutes);

app.get('/database', async (req, res) => {
    const result = await checkDatabaseConnection();
    return res.status(result.success ? 200 : 503).json(result);
});

app.get('/runtime', (req, res) => {
    res.json({
        success: true,
        timestamp: new Date().toISOString(),
        runtime: {
            nodeEnv: rawNodeEnv,
            vercel: isVercel,
            production: isProduction
        },
        config: {
            productionConfigError,
            hasDbHost: Boolean(DB_HOST),
            dbHost: DB_HOST || null,
            dbPort: DB_PORT || 3306,
            dbName: DB_NAME || null,
            hasSessionSecret: Boolean(sessionSecret),
            hasJwtSecret: Boolean(jwtSecret),
            hasJwtRefreshSecret: Boolean(jwtRefreshSecret),
            uploadStorage: isBlobStorageEnabled() ? 'blob' : 'local',
            hasBlobReadWriteToken: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
            appBaseUrl: appBaseUrl || null,
            corsOrigins: allowedOrigins
        }
    });
});

// Swagger documentation
app.use('/api-docs', serve, setup);

// Root redirect
app.get('/', (req, res) => {
    res.redirect('/admin/login');
});

// 404 handler
app.use((req, res) => {
    // Check if request is for API endpoint
    if (req.path.startsWith('/api')) {
        return res.status(404).json({ 
            success: false, 
            message: 'API endpoint not found',
            code: 'ENDPOINT_NOT_FOUND'
        });
    }
    
    // Render 404 page for web requests
    res.status(404).render('404');
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Error:', err.stack);
    
    // Check if request is for API endpoint
    if (req.path.startsWith('/api')) {
        return res.status(500).json({ 
            success: false, 
            message: 'Internal server error',
            code: 'SERVER_ERROR',
            ...(process.env.NODE_ENV === 'development' && { error: err.message })
        });
    }
    
    // Render 500 page for web requests
    res.status(500).render('500', { 
        error: err,
        message: err.message 
    });
});

// Start server
async function startServer() {
    try {
        if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
            throw new Error('PORT must be a valid TCP port');
        }

        const server = app.listen(PORT, '0.0.0.0', () => {
            console.log(`Server running at http://localhost:${PORT}`);
        });

        server.on('error', (error) => {
            console.error('HTTP server error:', error.message);
            process.exit(1);
        });

        ensureDatabaseReady()
            .then(() => {
                app.locals.databaseReady = true;
            })
            .catch((error) => {
                app.locals.databaseReady = false;
                app.locals.databaseStartupError = error.message;
                console.error('Database readiness failed:', error.message);
            });

        if (isProduction && isEmailConfigured()) {
            verifyEmailTransport()
                .then(() => console.log('SMTP transporter verified'))
                .catch((emailError) => console.error('SMTP verification failed:', emailError.message));
        } else if (!isEmailConfigured()) {
            console.warn('SMTP is not configured. Email verification will stay in log mode.');
        }

        const gracefulShutdown = (signal) => {
            console.log(`${signal} received. Shutting down server gracefully...`);
            server.close(() => {
                console.log('HTTP server closed');
                process.exit(0);
            });

            setTimeout(() => {
                console.error('Forced shutdown after timeout');
                process.exit(1);
            }, 10000).unref();
        };

        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        
    } catch (error) {
        console.error('Failed to start server:', error.message);
        process.exit(1);
    }
}

if (isVercel) {
    module.exports = app;
} else {
    startServer();
    module.exports = app;
}
