const ExcelJS = require('exceljs');

/**
 * Generate Excel file untuk laporan absensi dengan kop surat
 * @param {Array} data - Data presensi
 * @param {Object} filter - Filter yang digunakan
 * @param {Object} officeSetting - Setting kantor
 * @returns {Promise<Buffer>} Excel file buffer
 */
async function generateAttendanceExcel(data, filter, officeSetting) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Laporan Absensi');

  // Set column widths
  worksheet.columns = [
    { key: 'no', width: 5 },
    { key: 'nik', width: 15 },
    { key: 'nama', width: 25 },
    { key: 'jabatan', width: 20 },
    { key: 'tanggal', width: 12 },
    { key: 'jam_masuk', width: 12 },
    { key: 'jam_keluar', width: 12 },
    { key: 'durasi', width: 12 },
    { key: 'status_lokasi', width: 15 },
    { key: 'jarak', width: 10 },
    { key: 'keterangan', width: 20 }
  ];

  // KOP SURAT
  // Logo/Title Row
  worksheet.mergeCells('A1:K1');
  const titleRow = worksheet.getCell('A1');
  titleRow.value = 'FLEUR CAFÉ - Atelier d\'artistes';
  titleRow.font = { size: 16, bold: true, color: { argb: 'FF8B6914' } };
  titleRow.alignment = { vertical: 'middle', horizontal: 'center' };
  titleRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF0EBE4' }
  };
  worksheet.getRow(1).height = 25;

  // Address Row
  worksheet.mergeCells('A2:K2');
  const addressRow = worksheet.getCell('A2');
  addressRow.value = 'Jl. Contoh No. 123, Denpasar, Bali';
  addressRow.font = { size: 10, italic: true };
  addressRow.alignment = { vertical: 'middle', horizontal: 'center' };

  // Contact Row
  worksheet.mergeCells('A3:K3');
  const contactRow = worksheet.getCell('A3');
  contactRow.value = 'Telp: (0361) 123456 | Email: info@fleurcafe.com';
  contactRow.font = { size: 10, italic: true };
  contactRow.alignment = { vertical: 'middle', horizontal: 'center' };

  // Divider
  worksheet.mergeCells('A4:K4');
  const dividerRow = worksheet.getCell('A4');
  dividerRow.border = {
    bottom: { style: 'double', color: { argb: 'FF8B6914' } }
  };

  // Report Title
  worksheet.mergeCells('A5:K5');
  const reportTitle = worksheet.getCell('A5');
  reportTitle.value = 'LAPORAN ABSENSI KARYAWAN';
  reportTitle.font = { size: 14, bold: true };
  reportTitle.alignment = { vertical: 'middle', horizontal: 'center' };
  worksheet.getRow(5).height = 20;

  // Filter Info
  let filterText = 'Periode: ';
  if (filter.type === 'date') {
    filterText += new Date(filter.startDate).toLocaleDateString('id-ID');
  } else if (filter.type === 'range') {
    filterText += `${new Date(filter.startDate).toLocaleDateString('id-ID')} - ${new Date(filter.endDate).toLocaleDateString('id-ID')}`;
  } else if (filter.type === 'month') {
    const monthNames = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    filterText += `${monthNames[filter.month - 1]} ${filter.year}`;
  } else if (filter.type === 'year') {
    filterText += `Tahun ${filter.year}`;
  }

  worksheet.mergeCells('A6:K6');
  const filterInfo = worksheet.getCell('A6');
  filterInfo.value = filterText;
  filterInfo.font = { size: 10, italic: true };
  filterInfo.alignment = { vertical: 'middle', horizontal: 'center' };

  // Empty row
  worksheet.addRow([]);

  // HEADER TABLE
  const headerRow = worksheet.addRow([
    'No',
    'NIK',
    'Nama',
    'Jabatan',
    'Tanggal',
    'Jam Masuk',
    'Jam Keluar',
    'Durasi Kerja',
    'Status Lokasi',
    'Jarak (m)',
    'Keterangan'
  ]);

  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF8B6914' }
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 20;

  // Add borders to header
  headerRow.eachCell((cell) => {
    cell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    };
  });

  // DATA ROWS
  const reportRows = (data || []).map(item => {
    const status = String(item.status || '').toLowerCase();
    const isPresent = ['hadir', 'present', 'late'].includes(status);
    const isLate = status === 'late';
    const hasInsideRadius = item.distance_in != null
      ? Number(item.distance_in) <= Number(officeSetting?.radius_meter || 100)
      : true;

    return {
      nik: item.nik || '-',
      nama: item.nama || '-',
      jabatan: item.jabatan || '-',
      tanggal: item.tanggal ? new Date(item.tanggal).toLocaleDateString('id-ID') : '-',
      jam_masuk: item.jam_masuk || null,
      jam_keluar: item.jam_keluar || null,
      status_lokasi: hasInsideRadius ? 'Dalam Area' : 'Luar Area',
      jarak: item.distance_in != null ? Number(item.distance_in).toFixed(2) : '-',
      is_late: isLate,
      is_present: isPresent
    };
  });

  // Calculate duration and add rows
  let rowNumber = 1;
  reportRows.forEach(item => {
    let durasi = '-';
    let keterangan = [];

    if (item.jam_masuk && item.jam_keluar) {
      // Calculate duration (simplified)
      const [jamMasuk, menitMasuk] = item.jam_masuk.split(':').map(Number);
      const [jamKeluar, menitKeluar] = item.jam_keluar.split(':').map(Number);
      const totalMenitMasuk = jamMasuk * 60 + menitMasuk;
      const totalMenitKeluar = jamKeluar * 60 + menitKeluar;
      const durasiMenit = totalMenitKeluar - totalMenitMasuk;
      const jam = Math.floor(durasiMenit / 60);
      const menit = durasiMenit % 60;
      durasi = `${jam}j ${menit}m`;
    }

    if (item.is_late) keterangan.push('Terlambat');
    if (item.status_lokasi !== 'Dalam Area') keterangan.push('Luar Area');
    if (!item.is_present) keterangan.push(`Status: ${item.status_lokasi === 'Dalam Area' ? 'Tidak Hadir' : 'Tidak Hadir (Luar Area)'}`);
    if (item.is_present && !item.jam_masuk) keterangan.push('Belum Absen Masuk');
    if (item.is_present && !item.jam_keluar) keterangan.push('Belum Absen Pulang');

    const dataRow = worksheet.addRow([
      rowNumber++,
      item.nik,
      item.nama,
      item.jabatan,
      item.tanggal,
      item.jam_masuk || '-',
      item.jam_keluar || '-',
      durasi,
      item.status_lokasi,
      item.jarak,
      keterangan.join(', ') || 'Normal'
    ]);

    // Styling
    dataRow.alignment = { vertical: 'middle', horizontal: 'left' };
    dataRow.getCell(1).alignment = { horizontal: 'center' };
    dataRow.getCell(5).alignment = { horizontal: 'center' };
    dataRow.getCell(6).alignment = { horizontal: 'center' };
    dataRow.getCell(7).alignment = { horizontal: 'center' };
    dataRow.getCell(8).alignment = { horizontal: 'center' };
    dataRow.getCell(9).alignment = { horizontal: 'center' };
    dataRow.getCell(10).alignment = { horizontal: 'center' };

    // Add borders
    dataRow.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD4BFA6' } },
        left: { style: 'thin', color: { argb: 'FFD4BFA6' } },
        bottom: { style: 'thin', color: { argb: 'FFD4BFA6' } },
        right: { style: 'thin', color: { argb: 'FFD4BFA6' } }
      };
    });

    // Highlight issues
    if (keterangan.length > 0 && keterangan[0] !== 'Normal') {
      dataRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFFF4E6' }
      };
    }
  });

  // SUMMARY
  worksheet.addRow([]);
  const summaryRow = worksheet.addRow(['', '', 'RINGKASAN:', '', '', '', '', '', '', '', '']);
  summaryRow.font = { bold: true };
  summaryRow.getCell(3).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF0EBE4' }
  };

  const totalPresensi = reportRows.length;
  const dalamArea = reportRows.filter(item => item.status_lokasi === 'Dalam Area').length;
  const luarArea = totalPresensi - dalamArea;

  worksheet.addRow(['', '', `Total Presensi: ${totalPresensi}`, '', '', '', '', '', '', '', '']);
  worksheet.addRow(['', '', `Dalam Area: ${dalamArea}`, '', '', '', '', '', '', '', '']);
  worksheet.addRow(['', '', `Luar Area: ${luarArea}`, '', '', '', '', '', '', '', '']);

  // FOOTER
  worksheet.addRow([]);
  worksheet.addRow([]);
  const footerRow = worksheet.addRow(['', '', '', '', '', '', '', '', '', `Denpasar, ${new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Makassar' })}`, '']);
  footerRow.alignment = { horizontal: 'center' };

  worksheet.addRow(['', '', '', '', '', '', '', '', '', 'Mengetahui,', '']);
  worksheet.addRow([]);
  worksheet.addRow([]);
  worksheet.addRow([]);
  worksheet.addRow(['', '', '', '', '', '', '', '', '', '(_____________)', '']);
  worksheet.addRow(['', '', '', '', '', '', '', '', '', 'Manager', '']);

  // Generate buffer
  const buffer = await workbook.xlsx.writeBuffer();
  return buffer;
}

/**
 * Generate Excel sederhana (generic) untuk laporan tabel apa pun.
 * @param {Object} opts
 * @param {string} opts.title - Judul di baris atas
 * @param {string} [opts.periodLabel] - Sub-judul (mis. periode/keterangan)
 * @param {Array<{key:string, header:string, width?:number, align?:string}>} opts.columns
 * @param {Array<Object>} opts.rows - Data (properti sesuai columns[].key)
 * @returns {Promise<Buffer>}
 */
async function generateSimpleExcel({ title, periodLabel, columns, rows }) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Data');
  const lastCol = columns.length;
  const thin = { style: 'thin', color: { argb: 'FF999999' } };
  const border = { top: thin, bottom: thin, left: thin, right: thin };

  columns.forEach((c, i) => { worksheet.getColumn(i + 1).width = c.width || 18; });

  // Judul
  worksheet.mergeCells(1, 1, 1, lastCol);
  const titleCell = worksheet.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { bold: true, size: 14 };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };

  let headerRowIdx = 3;
  if (periodLabel) {
    worksheet.mergeCells(2, 1, 2, lastCol);
    const subCell = worksheet.getCell(2, 1);
    subCell.value = periodLabel;
    subCell.alignment = { horizontal: 'center' };
    headerRowIdx = 4;
  }

  // Header kolom
  const headerRow = worksheet.getRow(headerRowIdx);
  columns.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8B5E3C' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = border;
  });

  // Data
  rows.forEach((row, ri) => {
    const r = worksheet.getRow(headerRowIdx + 1 + ri);
    columns.forEach((c, ci) => {
      const cell = r.getCell(ci + 1);
      const v = row[c.key];
      cell.value = (v === null || v === undefined) ? '' : v;
      cell.alignment = { horizontal: c.align || 'left', vertical: 'middle', wrapText: true };
      cell.border = border;
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer;
}

module.exports = {
  generateAttendanceExcel,
  generateSimpleExcel
};
