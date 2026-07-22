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

/**
 * Hitung ulang presensi PENGGANTI untuk sebuah izin yang disetujui, agar jam menutupi
 * (window cover) yang jatuh DI LUAR shift pengganti terhitung sebagai lembur — konsisten
 * dengan logika clock-out. Dipanggil setelah manager approve / menetapkan pengganti /
 * mengubah jam, sehingga bila pengganti sudah terlanjur clock-out, lemburnya tetap
 * dikreditkan (bukan hanya saat clock-out).
 *
 * Window cover = jam yang ditetapkan manager pada izin (absensi.jam_mulai/selesai); bila
 * kosong, fallback ke shift orang yang digantikan. Efektif & batas lembur tetap memakai
 * shift PENGGANTI sendiri (tidak berubah), yang bertambah hanya overtime_minutes.
 *
 * @param {*} connection  koneksi/pool dengan .execute (config/database)
 * @param {number} absensiId  id pengajuan izin (absensi)
 * @param {string} [devToday]  DEV MODE saja: bila diisi (tanggal WITA "YYYY-MM-DD"), presensi
 *   dicocokkan ke tanggal ini alih-alih rentang tanggal izin — supaya testing tetap jalan
 *   walau tanggal pengajuan izin berbeda dari tanggal presensi (repeatable attendance dev mode).
 *   Kosongkan di production agar tetap ketat sesuai rentang tanggal izin.
 * @returns {Promise<number>} jumlah record presensi pengganti yang diperbarui
 */
async function recalcSubstitutePresensiForLeave(connection, absensiId, devToday = null) {
  const [leaveRows] = await connection.execute(
    `SELECT id_karyawan, tanggal_mulai, tanggal_selesai, status,
            TIME(jam_mulai) AS jam_mulai, TIME(jam_selesai) AS jam_selesai
       FROM absensi WHERE id = ? LIMIT 1`,
    [absensiId]
  );
  if (!leaveRows.length) return 0;
  const leave = leaveRows[0];
  if (!['approved', 'disetujui'].includes(String(leave.status))) return 0;

  // Shift orang yang digantikan (fallback window bila manager tidak mengisi jam).
  const [coveredSchedRows] = await connection.execute(
    `SELECT TIME(s.jam_masuk) AS jam_masuk, TIME(s.jam_keluar) AS jam_keluar
       FROM karyawan k
       LEFT JOIN jadwal_kerja jk ON k.id_jadwal_kerja = jk.id
       LEFT JOIN shift s ON s.id = COALESCE(k.shift_id, jk.shift_id)
      WHERE k.id = ? LIMIT 1`,
    [leave.id_karyawan]
  );
  const coveredShift = coveredSchedRows[0] || {};
  const coverageWindow = {
    start: leave.jam_mulai || coveredShift.jam_masuk || null,
    end: leave.jam_selesai || coveredShift.jam_keluar || null
  };
  if (!coverageWindow.start || !coverageWindow.end) return 0; // tak ada window -> tak ada kredit

  // Pengganti yang disetujui untuk izin ini.
  const [subRows] = await connection.execute(
    `SELECT DISTINCT id_pengganti FROM permintaan_absensi
      WHERE id_absensi = ? AND status = 'disetujui' AND id_pengganti IS NOT NULL`,
    [absensiId]
  );

  let updated = 0;
  for (const sub of subRows) {
    const substituteId = sub.id_pengganti;
    // Shift pengganti SENDIRI (untuk overlap efektif & titik akhir shift) - sumber sama dgn clock-out.
    const [subSchedRows] = await connection.execute(
      `SELECT s.jam_masuk, s.jam_keluar
         FROM karyawan k
         LEFT JOIN jadwal_kerja jk ON k.id_jadwal_kerja = jk.id
         LEFT JOIN shift s ON s.id = COALESCE(k.shift_id, jk.shift_id)
        WHERE k.id = ? LIMIT 1`,
      [substituteId]
    );
    const subSchedule = subSchedRows[0] || null;

    const dateFilter = devToday ? 'tanggal = ?' : 'tanggal BETWEEN ? AND ?';
    const dateParams = devToday ? [devToday] : [leave.tanggal_mulai, leave.tanggal_selesai];
    const [presRows] = await connection.execute(
      `SELECT id, DATE_FORMAT(tanggal, '%Y-%m-%d') AS tgl,
              TIME(jam_masuk) AS ci, TIME(jam_keluar) AS co, data_masuk
         FROM presensi
        WHERE id_karyawan = ?
          AND ${dateFilter}
          AND jam_masuk IS NOT NULL
          AND jam_keluar IS NOT NULL`,
      [substituteId, ...dateParams]
    );

    for (const p of presRows) {
      const approvedLeave = await getApprovedLeaveForDate(connection, substituteId, p.tgl);
      const leaveMinutes = calculateLeaveMinutes(approvedLeave);
      const breakMinutes = getCountedBreakFromDataMasuk(p.data_masuk);
      const summary = calculateWorkSummary({
        schedule: subSchedule,
        checkInTime: p.ci,
        checkOutTime: p.co,
        leaveMinutes,
        breakMinutes,
        coverageWindow
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
  }
  return updated;
}

module.exports = { recalcPresensiForLeave, recalcSubstitutePresensiForLeave };
