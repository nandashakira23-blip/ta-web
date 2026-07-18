/**
 * ============================================================
 * RECOMPUTE PRESENSI SAAT IZIN DISETUJUI
 * ============================================================
 * Ketika manager menyetujui izin SETELAH karyawan clock-out, nilai
 * approved_leave_minutes & effective_work_minutes yang tersimpan (dihitung
 * saat clock-out) belum memasukkan izin tersebut. Helper ini menghitung ulang
 * presensi pada rentang tanggal izin agar konsisten dengan logika clock-out.
 *
 * Konsisten dengan clock-out (routes/api.js):
 *   - izin per tanggal  : getApprovedLeaveForDate + calculateLeaveMinutes
 *   - istirahat         : data_masuk.istirahat.dihitung_menit (yang dihitung saat clock-out)
 *   - ringkasan         : calculateWorkSummary (utils/worktime.js)
 */
const { calculateWorkSummary, calculateLeaveMinutes } = require('./worktime');

function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (e) { return {}; }
}

// Menit istirahat yang DIHITUNG (disimpan saat clock-out) dari data_masuk.
function getCountedBreakFromDataMasuk(dataMasuk) {
  const istirahat = parseJson(dataMasuk).istirahat || {};
  const counted = Number(istirahat.dihitung_menit);
  return Number.isFinite(counted) && counted > 0 ? counted : 0;
}

// Izin disetujui yang mencakup sebuah tanggal (mirror routes/api.js getApprovedLeaveForDate).
async function getApprovedLeaveForDate(connection, employeeId, date) {
  const [rows] = await connection.execute(
    `SELECT * FROM absensi
      WHERE id_karyawan = ?
        AND status IN ('approved', 'disetujui')
        AND tanggal_mulai <= ?
        AND tanggal_selesai >= ?
      ORDER BY created_at DESC
      LIMIT 1`,
    [employeeId, date, date]
  );
  return rows[0] || null;
}

/**
 * Hitung ulang presensi (approved_leave_minutes, effective, overtime, late, early)
 * untuk semua hari dalam rentang izin yang baru disetujui.
 * @param {*} connection  koneksi/pool dengan .execute (config/database)
 * @param {number} absensiId  id pengajuan izin (absensi)
 * @returns {Promise<number>} jumlah record presensi yang diperbarui
 */
async function recalcPresensiForLeave(connection, absensiId) {
  const [leaveRows] = await connection.execute(
    `SELECT id_karyawan, tanggal_mulai, tanggal_selesai, status
       FROM absensi WHERE id = ? LIMIT 1`,
    [absensiId]
  );
  if (!leaveRows.length) return 0;
  const leave = leaveRows[0];
  if (!['approved', 'disetujui'].includes(String(leave.status))) return 0;

  // Shift karyawan (untuk overlap efektif) - sama sumbernya dengan clock-out.
  const [schedRows] = await connection.execute(
    `SELECT s.jam_masuk, s.jam_keluar
       FROM karyawan k
       LEFT JOIN jadwal_kerja jk ON k.id_jadwal_kerja = jk.id
       LEFT JOIN shift s ON s.id = COALESCE(k.shift_id, jk.shift_id)
      WHERE k.id = ? LIMIT 1`,
    [leave.id_karyawan]
  );
  const schedule = schedRows[0] || null;

  // Presensi lengkap (masuk & keluar) dalam rentang izin.
  const [presRows] = await connection.execute(
    `SELECT id, DATE_FORMAT(tanggal, '%Y-%m-%d') AS tgl,
            TIME(jam_masuk) AS ci, TIME(jam_keluar) AS co, data_masuk
       FROM presensi
      WHERE id_karyawan = ?
        AND tanggal BETWEEN ? AND ?
        AND jam_masuk IS NOT NULL
        AND jam_keluar IS NOT NULL`,
    [leave.id_karyawan, leave.tanggal_mulai, leave.tanggal_selesai]
  );

  let updated = 0;
  for (const p of presRows) {
    const approvedLeave = await getApprovedLeaveForDate(connection, leave.id_karyawan, p.tgl);
    const leaveMinutes = calculateLeaveMinutes(approvedLeave);
    const breakMinutes = getCountedBreakFromDataMasuk(p.data_masuk);
    const summary = calculateWorkSummary({
      schedule,
      checkInTime: p.ci,
      checkOutTime: p.co,
      leaveMinutes,
      breakMinutes
    });
    await connection.execute(
      `UPDATE presensi
          SET approved_leave_minutes = ?,
              effective_work_minutes = ?,
              overtime_minutes = ?,
              late_minutes = ?,
              early_leave_minutes = ?
        WHERE id = ?`,
      [
        summary.approvedLeaveMinutes,
        summary.effectiveWorkMinutes,
        summary.overtimeMinutes,
        summary.lateMinutes,
        summary.earlyLeaveMinutes,
        p.id
      ]
    );
    updated++;
  }
  return updated;
}

module.exports = { recalcPresensiForLeave };
