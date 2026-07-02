const crypto = require('crypto');
const nodemailer = require('nodemailer');

let cachedTransporter = null;

function generateVerificationToken() {
    return crypto.randomBytes(24).toString('hex');
}

function generateVerificationOtp(length = 6) {
    const max = Math.pow(10, length);
    return String(Math.floor(Math.random() * max)).padStart(length, '0');
}

function getVerificationExpiry(hours = 24) {
    const expiry = new Date();
    expiry.setHours(expiry.getHours() + hours);
    return expiry;
}

function buildVerificationUrl(token, email) {
    const baseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const params = new URLSearchParams({ token, email });
    return `${baseUrl}/api/auth/verify-email?${params.toString()}`;
}

function isEmailConfigured() {
    return Boolean(
        process.env.SMTP_HOST &&
        process.env.SMTP_PORT &&
        process.env.SMTP_USER &&
        process.env.SMTP_PASS &&
        process.env.MAIL_FROM
    );
}

function getTransporter() {
    if (!isEmailConfigured()) {
        return null;
    }

    if (!cachedTransporter) {
        cachedTransporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT),
            secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || Number(process.env.SMTP_PORT) === 465,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });
    }

    return cachedTransporter;
}

async function verifyEmailTransport() {
    const transporter = getTransporter();
    if (!transporter) {
        return {
            ok: false,
            mode: 'log',
            message: 'SMTP is not configured'
        };
    }

    await transporter.verify();
    return {
        ok: true,
        mode: 'smtp'
    };
}

async function sendVerificationEmail({ email, name, token }) {
    const verificationUrl = buildVerificationUrl(token, email);
    const subject = 'Kode OTP Verifikasi Email Akun Presensi';
    const text = `Halo ${name || 'Karyawan'}, kode OTP verifikasi email Anda adalah ${token}. Berlaku selama 24 jam.`;
    const html = `
        <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.6;">
            <h2 style="color: #8b6914;">OTP Verifikasi Email Akun Presensi</h2>
            <p>Halo ${name || 'Karyawan'},</p>
            <p>Masukkan kode OTP berikut untuk menyelesaikan aktivasi akun:</p>
            <p style="font-size: 28px; font-weight: bold; letter-spacing: 6px; color: #111827;">${token}</p>
            <p>Kode berlaku selama 24 jam.</p>
            <p style="font-size: 12px; color: #6b7280;">Link cadangan: <a href="${verificationUrl}">${verificationUrl}</a></p>
        </div>
    `;

    const transporter = getTransporter();
    if (!transporter) {
        const payload = { to: email, subject, text };
        console.warn('[EMAIL VERIFICATION][LOG MODE]', payload);
        return {
            mode: 'log',
            verificationUrl
        };
    }

    await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: email,
        subject,
        text,
        html
    });

    return {
        mode: 'smtp',
        verificationUrl
    };
}

module.exports = {
    generateVerificationToken,
    generateVerificationOtp,
    getVerificationExpiry,
    buildVerificationUrl,
    sendVerificationEmail,
    verifyEmailTransport,
    isEmailConfigured
};
