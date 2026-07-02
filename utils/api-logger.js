/**
 * API Activity Logger
 * Logs all important API activities to console for monitoring
 */

// Try to use chalk if available, otherwise use plain console
let chalk;
try {
  chalk = require('chalk');
} catch (e) {
  // Fallback to plain text if chalk is not installed
  chalk = {
    blue: (text) => text,
    green: (text) => text,
    magenta: (text) => text,
    yellow: (text) => text,
    red: (text) => text,
    cyan: (text) => text,
    gray: (text) => text
  };
}

// Color codes for different activity types
const colors = {
  auth: chalk.blue,
  attendance: chalk.green,
  face: chalk.magenta,
  activation: chalk.yellow,
  error: chalk.red,
  success: chalk.green,
  info: chalk.cyan
};

/**
 * Log API activity with formatted output
 * @param {string} type - Activity type (auth, attendance, face, etc.)
 * @param {string} action - Action description
 * @param {object} details - Additional details to log
 * @param {boolean} success - Whether the action was successful
 */
function logActivity(type, action, details = {}, success = true) {
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'Asia/Makassar' });
  const statusIcon = success ? '[OK]' : '[FAIL]';
  const colorFn = colors[type] || colors.info;
  
  console.log('\n' + '='.repeat(100));
  console.log(colorFn(`${statusIcon} [${timestamp}] ${type.toUpperCase()}: ${action}`));
  
  if (Object.keys(details).length > 0) {
    // Filter sensitive data
    const safeDetails = { ...details };
    if (safeDetails.pin) safeDetails.pin = '***';
    if (safeDetails.password) safeDetails.password = '***';
    if (safeDetails.token) safeDetails.token = safeDetails.token.substring(0, 20) + '...';
    if (safeDetails.accessToken) safeDetails.accessToken = safeDetails.accessToken.substring(0, 20) + '...';
    if (safeDetails.refreshToken) safeDetails.refreshToken = safeDetails.refreshToken.substring(0, 20) + '...';
    
    console.log(chalk.gray('Details:'));
    Object.entries(safeDetails).forEach(([key, value]) => {
      if (typeof value === 'object' && value !== null) {
        console.log(chalk.gray(`  ${key}:`), JSON.stringify(value, null, 2));
      } else {
        console.log(chalk.gray(`  ${key}:`), value);
      }
    });
  }
  
  console.log('='.repeat(100) + '\n');
}

/**
 * Express middleware to log all API requests
 */
function apiLoggerMiddleware(req, res, next) {
  // Skip logging for certain endpoints
  const skipPaths = ['/validation/location'];
  if (skipPaths.some(path => req.path.includes(path))) {
    return next();
  }
  
  const start = Date.now();
  const originalJson = res.json;
  
  // Override res.json to capture response
  res.json = function(data) {
    const duration = Date.now() - start;
    const success = data.success !== false && res.statusCode < 400;
    
    // Determine activity type from path
    let type = 'info';
    if (req.path.includes('/auth')) type = 'auth';
    else if (req.path.includes('/attendance') || req.path.includes('/checkin') || req.path.includes('/checkout')) type = 'attendance';
    else if (req.path.includes('/face') || req.path.includes('/upload')) type = 'face';
    else if (req.path.includes('/activation')) type = 'activation';
    
    const details = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
      user: req.user ? `${req.user.nik} (ID: ${req.user.id})` : 'Anonymous',
      ip: req.ip || req.connection.remoteAddress
    };
    
    // Add request body (excluding sensitive fields and files)
    if (req.body && Object.keys(req.body).length > 0) {
      const safeBody = { ...req.body };
      delete safeBody.pin;
      delete safeBody.password;
      delete safeBody.confirmPin;
      if (Object.keys(safeBody).length > 0) {
        details.body = safeBody;
      }
    }
    
    // Add file info if present
    if (req.file) {
      details.file = {
        fieldname: req.file.fieldname,
        originalname: req.file.originalname,
        size: `${(req.file.size / 1024).toFixed(2)} KB`,
        mimetype: req.file.mimetype
      };
    }
    
    // Add response message if present
    if (data.message) {
      details.message = data.message;
    }
    
    // Add error code if present
    if (data.code) {
      details.code = data.code;
    }
    
    logActivity(type, `${req.method} ${req.path}`, details, success);
    
    return originalJson.call(this, data);
  };
  
  next();
}

/**
 * Log specific activities with custom messages
 */
const logger = {
  login: (nik, success, reason = '') => {
    logActivity('auth', `Login attempt`, { nik, success, reason }, success);
  },
  
  logout: (nik) => {
    logActivity('auth', `Logout`, { nik }, true);
  },
  
  activation: (nik, step, success = true) => {
    logActivity('activation', `Activation ${step}`, { nik }, success);
  },
  
  faceUpload: (userId, nik, facesDetected, success = true) => {
    logActivity('face', `Face reference upload`, { userId, nik, facesDetected }, success);
  },
  
  clockIn: (userId, nik, location, faceMatch, success = true) => {
    logActivity('attendance', `Clock In`, { 
      userId, 
      nik, 
      location: `${location.latitude}, ${location.longitude}`,
      locationValid: location.isValid,
      distance: `${location.distance}m`,
      faceMatch: faceMatch.isMatch,
      similarity: `${(faceMatch.similarity * 100).toFixed(1)}%`
    }, success);
  },
  
  clockOut: (userId, nik, location, workDuration, success = true) => {
    logActivity('attendance', `Clock Out`, { 
      userId, 
      nik, 
      location: `${location.latitude}, ${location.longitude}`,
      locationValid: location.isValid,
      distance: `${location.distance}m`,
      workDuration
    }, success);
  },
  
  pinChange: (userId, nik, success = true) => {
    logActivity('auth', `PIN change`, { userId, nik }, success);
  },
  
  error: (action, error, details = {}) => {
    logActivity('error', action, { 
      error: error.message || error,
      ...details
    }, false);
  }
};

module.exports = {
  logActivity,
  apiLoggerMiddleware,
  logger
};
