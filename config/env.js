const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function resolveEnvPath(rootDir) {
  const requestedPath = process.env.DOTENV_CONFIG_PATH || process.env.DOTENV_CONFIG_FILE;

  if (requestedPath) {
    return path.isAbsolute(requestedPath)
      ? requestedPath
      : path.resolve(rootDir, requestedPath);
  }

  const defaultFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env';
  return path.resolve(rootDir, defaultFile);
}

function loadEnv(options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const envPath = resolveEnvPath(rootDir);

  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    return { loaded: true, path: envPath };
  }

  if (process.env.NODE_ENV !== 'production') {
    dotenv.config({ path: path.resolve(rootDir, '.env') });
  }

  return { loaded: false, path: envPath };
}

module.exports = loadEnv;
