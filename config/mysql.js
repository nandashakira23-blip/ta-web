const fs = require('fs');

function parseBooleanLike(value, defaultValue = false) {
  if (value === undefined || value === '') {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'required', 'require'].includes(String(value).toLowerCase());
}

function getSslConfig() {
  if (!parseBooleanLike(process.env.DB_SSL || process.env.MYSQL_SSL)) {
    return {};
  }

  const ssl = {
    rejectUnauthorized: parseBooleanLike(process.env.DB_SSL_REJECT_UNAUTHORIZED, false)
  };

  if (process.env.DB_SSL_CA) {
    ssl.ca = fs.readFileSync(process.env.DB_SSL_CA);
    ssl.rejectUnauthorized = true;
  }

  return { ssl };
}

function getMysqlBaseConfig() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    ...getSslConfig()
  };
}

function getMysqlConfig() {
  return {
    ...getMysqlBaseConfig(),
    database: process.env.DB_NAME || 'presensi_fleur_atelier'
  };
}

module.exports = {
  getMysqlBaseConfig,
  getMysqlConfig
};
