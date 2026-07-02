const fs = require('fs');
const os = require('os');
const path = require('path');
const { del, list, put } = require('@vercel/blob');

const BLOB_UPLOAD_PREFIX = 'uploads';

function isBlobStorageEnabled() {
  const uploadStorage = String(process.env.UPLOAD_STORAGE || '').toLowerCase();
  if (uploadStorage === 'local') return false;
  if (uploadStorage === 'blob') return true;
  return Boolean(process.env.VERCEL) && process.env.NODE_ENV === 'production';
}

function isBlobStorageConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function assertBlobStorageConfigured() {
  if (!isBlobStorageConfigured()) {
    throw new Error('BLOB_READ_WRITE_TOKEN belum diset untuk upload file di Vercel');
  }
}

function isRemoteFileUrl(value) {
  return /^https?:\/\//i.test(value || '');
}

function normalizeSlashes(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function ensureDirectorySync(directory) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function getUploadDestination(localDirectory) {
  if (!isBlobStorageEnabled()) {
    return localDirectory;
  }

  const safeDirectory = normalizeSlashes(localDirectory).replace(/[^a-zA-Z0-9._-]/g, '-');
  return path.join(os.tmpdir(), 'fleur-uploads', safeDirectory);
}

function createUploadStorage({ localDirectory, filenamePrefix }) {
  return {
    destination(req, file, cb) {
      const destination = getUploadDestination(localDirectory);
      ensureDirectorySync(destination);
      cb(null, destination);
    },
    filename(req, file, cb) {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      cb(null, `${filenamePrefix}-${uniqueSuffix}${path.extname(file.originalname)}`);
    }
  };
}

function getLocalDbPath(folder, filename) {
  return `${normalizeSlashes(folder)}/${filename}`;
}

function getBlobPath(folder, filename) {
  const normalizedFolder = normalizeSlashes(folder).replace(/^uploads\/?/, '');
  return `${BLOB_UPLOAD_PREFIX}/${normalizedFolder}/${filename}`.replace(/\/+/g, '/');
}

async function discardUploadedFile(file) {
  if (!file?.path) return;
  try {
    await fs.promises.unlink(file.path);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Failed to remove uploaded temp file:', error.message);
    }
  }
}

async function persistUploadedFile(file, { folder }) {
  if (!file) return null;

  const filename = file.filename || path.basename(file.path);
  if (!isBlobStorageEnabled()) {
    return getLocalDbPath(folder, filename);
  }

  assertBlobStorageConfigured();
  const blob = await put(getBlobPath(folder, filename), fs.createReadStream(file.path), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: file.mimetype || undefined
  });
  await discardUploadedFile(file);
  return blob.url;
}

function toPublicFileUrl(value) {
  if (!value) return null;
  if (isRemoteFileUrl(value)) return value;
  return `/${normalizeSlashes(value).replace(/^public\//, '')}`;
}

function getBlobPathnameFromUrl(value) {
  if (!value) return null;
  if (!isRemoteFileUrl(value)) {
    return normalizeSlashes(value);
  }

  try {
    return decodeURIComponent(new URL(value).pathname.replace(/^\/+/, ''));
  } catch (error) {
    return null;
  }
}

async function deleteStoredFile(value, rootDirectory = path.join(__dirname, '..')) {
  if (!value) return false;

  if (isRemoteFileUrl(value)) {
    if (!isBlobStorageConfigured()) return false;
    await del(value);
    return true;
  }

  const relativePath = normalizeSlashes(value);
  const candidates = [
    path.resolve(rootDirectory, relativePath),
    path.resolve(rootDirectory, 'public', relativePath.replace(/^public\//, '')),
    path.resolve(rootDirectory, 'public', 'uploads', relativePath),
    path.resolve(rootDirectory, 'public', 'uploads', 'karyawan', relativePath),
    path.resolve(rootDirectory, 'public', 'uploads', 'profiles', relativePath),
    path.resolve(rootDirectory, 'public', 'uploads', 'leave', relativePath)
  ];

  for (const candidate of candidates) {
    if (!candidate.startsWith(path.resolve(rootDirectory) + path.sep)) {
      continue;
    }

    try {
      const stat = await fs.promises.lstat(candidate);
      if (stat.isFile()) {
        await fs.promises.unlink(candidate);
        return true;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return false;
}

async function listBlobFilesByPrefixes(prefixes) {
  if (!isBlobStorageConfigured()) return [];

  const blobs = [];
  for (const prefix of prefixes) {
    let cursor;
    do {
      const result = await list({
        prefix: normalizeSlashes(prefix),
        cursor,
        limit: 1000
      });
      blobs.push(...result.blobs);
      cursor = result.cursor;
    } while (cursor);
  }
  return blobs;
}

module.exports = {
  createUploadStorage,
  deleteStoredFile,
  discardUploadedFile,
  getBlobPathnameFromUrl,
  isBlobStorageConfigured,
  isBlobStorageEnabled,
  isRemoteFileUrl,
  listBlobFilesByPrefixes,
  normalizeSlashes,
  persistUploadedFile,
  toPublicFileUrl
};
