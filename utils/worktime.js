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

function calculateWorkSummary({ schedule, checkInTime, checkOutTime, leaveMinutes = 0, breakMinutes = 0 }) {
    const scheduledStart = toMinutes(schedule?.jam_masuk);
    const scheduledEnd = toMinutes(schedule?.jam_keluar);
    const actualStart = toMinutes(checkInTime);
    const actualEnd = toMinutes(checkOutTime);

    const totalWorkMinutes = diffMinutes(actualStart, actualEnd);
    const scheduledMinutes = diffMinutes(scheduledStart, scheduledEnd);
    const lateMinutes = Math.max(0, (actualStart ?? 0) - (scheduledStart ?? 0));
    const earlyLeaveMinutes = Math.max(0, (scheduledEnd ?? 0) - (actualEnd ?? 0));
    const overtimeMinutes = Math.max(0, (actualEnd ?? 0) - (scheduledEnd ?? 0));
    const effectiveWorkMinutes = Math.max(0, totalWorkMinutes + leaveMinutes - lateMinutes - earlyLeaveMinutes - Number(breakMinutes || 0));

    return {
        scheduledMinutes,
        totalWorkMinutes,
        approvedLeaveMinutes: leaveMinutes,
        breakMinutes: Number(breakMinutes || 0),
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
