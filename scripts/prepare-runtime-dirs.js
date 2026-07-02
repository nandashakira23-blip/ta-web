const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const dirs = [
  'logs',
  'public/uploads/karyawan',
  'public/uploads/presensi',
  'public/uploads/profiles',
  'public/uploads/leave',
  'uploads/faces',
  'uploads/test'
];

for (const dir of dirs) {
  fs.mkdirSync(path.join(rootDir, dir), { recursive: true });
}

console.log('Runtime directories are ready.');
