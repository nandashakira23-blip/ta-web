const mysql = require('mysql2/promise');
const expressSession = require('express-session');

function getSessionExpiry(sessionData) {
  const cookie = sessionData && sessionData.cookie ? sessionData.cookie : {};
  if (cookie.expires) {
    const expiresAt = new Date(cookie.expires).getTime();
    if (Number.isFinite(expiresAt)) {
      return expiresAt;
    }
  }

  if (Number.isFinite(cookie.originalMaxAge)) {
    return Date.now() + Number(cookie.originalMaxAge);
  }

  return Date.now() + (24 * 60 * 60 * 1000);
}

function createMySqlSessionStore(sessionOrDbConfig = {}, maybeDbConfig = {}) {
  const session = sessionOrDbConfig && sessionOrDbConfig.Store ? sessionOrDbConfig : expressSession;
  const dbConfig = sessionOrDbConfig && sessionOrDbConfig.Store ? maybeDbConfig : sessionOrDbConfig;
  const Store = session.Store;

  class MySqlSessionStore extends Store {
    constructor() {
      super();
      this.pool = mysql.createPool({
        ...dbConfig,
        waitForConnections: true,
        connectionLimit: Number(process.env.SESSION_STORE_CONNECTION_LIMIT || 5),
        queueLimit: 0
      });
      this.ready = null;
    }

    ensureReady() {
      if (!this.ready) {
        this.ready = this.pool.execute(`
          CREATE TABLE IF NOT EXISTS sessions (
            sid VARCHAR(128) NOT NULL PRIMARY KEY,
            expires BIGINT UNSIGNED NOT NULL,
            data MEDIUMTEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_sessions_expires (expires)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
      }
      return this.ready;
    }

    get(sid, callback) {
      (async () => {
        await this.ensureReady();
        const [rows] = await this.pool.execute(
          'SELECT data, expires FROM sessions WHERE sid = ? LIMIT 1',
          [sid]
        );

        if (!rows.length) {
          return callback(null, null);
        }

        const row = rows[0];
        if (Number(row.expires) <= Date.now()) {
          await this.destroyAsync(sid);
          return callback(null, null);
        }

        return callback(null, JSON.parse(row.data));
      })().catch(error => callback(error));
    }

    set(sid, sessionData, callback = () => {}) {
      (async () => {
        await this.ensureReady();
        await this.pool.execute(
          `INSERT INTO sessions (sid, expires, data)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE
             expires = VALUES(expires),
             data = VALUES(data)`,
          [sid, getSessionExpiry(sessionData), JSON.stringify(sessionData)]
        );
        callback(null);
      })().catch(error => callback(error));
    }

    destroy(sid, callback = () => {}) {
      this.destroyAsync(sid)
        .then(() => callback(null))
        .catch(error => callback(error));
    }

    async destroyAsync(sid) {
      await this.ensureReady();
      await this.pool.execute('DELETE FROM sessions WHERE sid = ?', [sid]);
    }

    touch(sid, sessionData, callback = () => {}) {
      (async () => {
        await this.ensureReady();
        await this.pool.execute(
          'UPDATE sessions SET expires = ? WHERE sid = ?',
          [getSessionExpiry(sessionData), sid]
        );
        callback(null);
      })().catch(error => callback(error));
    }

    clear(callback = () => {}) {
      (async () => {
        await this.ensureReady();
        await this.pool.execute('DELETE FROM sessions');
        callback(null);
      })().catch(error => callback(error));
    }

    close() {
      return this.pool.end();
    }
  }

  return new MySqlSessionStore();
}

module.exports = createMySqlSessionStore;
