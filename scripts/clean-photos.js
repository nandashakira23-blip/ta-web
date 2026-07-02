/**
 * Script untuk membersihkan semua foto yang ada di folder uploads
 * Menghapus semua file foto di:
 * - public/uploads/karyawan/
 * - public/uploads/profiles/
 * - public/uploads/absensi/
 * - uploads/
 */

const fs = require('fs');
const path = require('path');

// Daftar folder yang akan dibersihkan
const uploadFolders = [
  'public/uploads/karyawan',
  'public/uploads/profiles',
  'public/uploads/absensi',
  'uploads'
];

// Ekstensi file gambar yang akan dihapus
const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];

/**
 * Hapus semua file gambar di folder
 */
function cleanFolder(folderPath) {
  if (!fs.existsSync(folderPath)) {
    console.log(`Folder tidak ditemukan: ${folderPath}`);
    return { deleted: 0, errors: 0 };
  }

  let deletedCount = 0;
  let errorCount = 0;

  try {
    const files = fs.readdirSync(folderPath);
    
    files.forEach(file => {
      // Skip .gitkeep
      if (file === '.gitkeep') {
        return;
      }

      const filePath = path.join(folderPath, file);
      const stat = fs.statSync(filePath);

      // Jika folder, rekursif
      if (stat.isDirectory()) {
        const result = cleanFolder(filePath);
        deletedCount += result.deleted;
        errorCount += result.errors;
      } 
      // Jika file gambar, hapus
      else if (stat.isFile()) {
        const ext = path.extname(file).toLowerCase();
        if (imageExtensions.includes(ext)) {
          try {
            fs.unlinkSync(filePath);
            console.log(`Dihapus: ${filePath}`);
            deletedCount++;
          } catch (error) {
            console.error(`Error menghapus ${filePath}:`, error.message);
            errorCount++;
          }
        }
      }
    });

  } catch (error) {
    console.error(`Error membaca folder ${folderPath}:`, error.message);
    errorCount++;
  }

  return { deleted: deletedCount, errors: errorCount };
}

/**
 * Main function
 */
function cleanAllPhotos() {
  console.log('==============================================');
  console.log('MEMBERSIHKAN SEMUA FOTO');
  console.log('==============================================\n');

  let totalDeleted = 0;
  let totalErrors = 0;

  uploadFolders.forEach(folder => {
    console.log(`\nMembersihkan folder: ${folder}`);
    console.log('----------------------------------------------');
    
    const result = cleanFolder(folder);
    totalDeleted += result.deleted;
    totalErrors += result.errors;
    
    console.log(`Selesai: ${result.deleted} file dihapus, ${result.errors} error`);
  });

  console.log('\n==============================================');
  console.log('RINGKASAN');
  console.log('==============================================');
  console.log(`Total file dihapus: ${totalDeleted}`);
  console.log(`Total error: ${totalErrors}`);
  console.log('==============================================\n');

  if (totalErrors > 0) {
    console.log('⚠️  Ada beberapa error saat menghapus file');
    process.exit(1);
  } else {
    console.log('✅ Semua foto berhasil dibersihkan!');
    process.exit(0);
  }
}

// Konfirmasi sebelum menghapus
console.log('==============================================');
console.log('⚠️  PERINGATAN');
console.log('==============================================');
console.log('Script ini akan menghapus SEMUA foto di:');
uploadFolders.forEach(folder => console.log(`  - ${folder}`));
console.log('\nFile .gitkeep akan tetap dipertahankan.');
console.log('==============================================\n');

// Jalankan
cleanAllPhotos();
