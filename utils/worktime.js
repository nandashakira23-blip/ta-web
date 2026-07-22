// Lembur minimal (menit) sebelum diakui: kelebihan jam kerja < 1 jam tidak dihitung lembur.
const OVERTIME_MIN_MINUTES = 60;

function toMinutes(timeValue) {
    if (!timeValue) return null;
    const [hours, minutes, seconds] = String(timeValue).split(':').map(Number);
    return (hours * 60) + minutes + Math.floor((seconds || 0) / 60);
}

function diffMinutes(start, end) {
    if (start == null || end == null) return 0;
    return Math.max(0, end - start);
}

const APPROVED_LEAVE_STATUSES = new Set(['approved', 'disetujui']);
function calculateLeaveMinutes(leaveRequest) {
    if (!leaveRequest || !APPROVED_LEAVE_STATUSES.has(leaveRequest.status)) return 0;
    const durationMinutes = leaveRequest.durasi_menit ?? leaveRequest.duration_minutes;
    if (durationMinutes && durationMinutes > 0) return durationMinutes;
    const start = toMinutes(leaveRequest.jam_mulai ?? leaveRequest.start_time);
    const end = toMinutes(leaveRequest.jam_selesai ?? leaveRequest.end_time);
    return diffMinutes(start, end);
}

function calculateWorkSummary({ schedule, checkInTime, checkOutTime, leaveMinutes = 0, breakMinutes = 0, coverageWindow = null }) {
    const scheduledStart = toMinutes(schedule?.jam_masuk);
    const scheduledEnd = toMinutes(schedule?.jam_keluar);
    const actualStart = toMinutes(checkInTime);
    const actualEnd = toMinutes(checkOutTime);

    const totalWorkMinutes = diffMinutes(actualStart, actualEnd);
    const scheduledMinutes = diffMinutes(scheduledStart, scheduledEnd);
    const lateMinutes = Math.max(0, (actualStart ?? 0) - (scheduledStart ?? 0));
    const earlyLeaveMinutes = Math.max(0, (scheduledEnd ?? 0) - (actualEnd ?? 0));
    const breakM = Number(breakMinutes || 0);

    // Lembur "biasa": waktu kerja SETELAH jam pulang shift sendiri.
    let overtimeAfterShift = 0;
    if (actualEnd != null && scheduledEnd != null) {
        const overtimeStart = Math.max(actualStart ?? 0, scheduledEnd);
        overtimeAfterShift = Math.max(0, actualEnd - overtimeStart);
    }

    // Lembur karena MENGGANTIKAN: bagian window pengganti (jam yang ditetapkan manager, atau
    // shift orang yang digantikan) yang BENAR-BENAR dikerjakan tapi jatuh SEBELUM jam masuk
    // shift sendiri. Ini "jam kerja melebihi shift normal" karena menutupi orang lain, jadi
    // diakui lembur. Bagian cover yang beririsan dengan shift sendiri TIDAK dihitung lagi
    // (sudah masuk jam kerja efektif) agar tidak dobel; bagian cover setelah shift sudah
    // tercakup di overtimeAfterShift.
    let coverageOvertime = 0;
    if (coverageWindow && actualStart != null && actualEnd != null && scheduledStart != null) {
        const covStart = toMinutes(coverageWindow.start ?? coverageWindow.jam_mulai);
        const covEnd = toMinutes(coverageWindow.end ?? coverageWindow.jam_selesai);
        if (covStart != null && covEnd != null && covEnd > covStart) {
            const segStart = Math.max(covStart, actualStart);
            const segEnd = Math.min(covEnd, actualEnd, scheduledStart);
            coverageOvertime = Math.max(0, segEnd - segStart);
        }
    }

    // Total lembur baru diakui bila akumulasinya >= 1 jam (kebijakan OVERTIME_MIN_MINUTES).
    const rawOvertime = overtimeAfterShift + coverageOvertime;
    const overtimeMinutes = rawOvertime >= OVERTIME_MIN_MINUTES ? rawOvertime : 0;

    // Efektif: irisan (overlap) jam kerja aktual dengan jadwal shift, + izin disetujui, - istirahat.
    let effectiveWorkMinutes;
    if (scheduledStart != null && scheduledEnd != null && actualStart != null && actualEnd != null) {
        const overlapStart = Math.max(actualStart, scheduledStart);
        const overlapEnd = Math.min(actualEnd, scheduledEnd);
        const inShiftMinutes = Math.max(0, overlapEnd - overlapStart);
        effectiveWorkMinutes = Math.max(0, inShiftMinutes + leaveMinutes - breakM);
    } else {
        effectiveWorkMinutes = Math.max(0, totalWorkMinutes + leaveMinutes - breakM);
    }

    return {
        scheduledMinutes,
        totalWorkMinutes,
        approvedLeaveMinutes: leaveMinutes,
        breakMinutes: breakM,
        lateMinutes,
        earlyLeaveMinutes,
        overtimeMinutes,
        effectiveWorkMinutes
    };
}

module.exports = {
    toMinutes,
    diffMinutes,
    calculateLeaveMinutes,
    calculateWorkSummary
};
