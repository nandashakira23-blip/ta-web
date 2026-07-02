// Middleware untuk proteksi rute admin
function requireAuth(req, res, next) {
    if (req.session && req.session.admin) {
        return next();
    }

    const acceptsJson = (req.get('accept') || '').includes('application/json');
    const sendsJson = (req.get('content-type') || '').includes('application/json');
    const ajaxRequest = req.xhr || acceptsJson || sendsJson || req.originalUrl.startsWith('/admin/api/');

    if (ajaxRequest) {
        return res.status(401).json({
            success: false,
            message: 'Session admin sudah berakhir. Silakan login ulang.',
            code: 'ADMIN_SESSION_EXPIRED'
        });
    }

    return res.redirect('/admin/login');
}

// Middleware untuk redirect jika sudah login
function redirectIfAuth(req, res, next) {
    if (req.session && req.session.admin) {
        return res.redirect('/admin/dashboard');
    } else {
        return next();
    }
}

module.exports = { requireAuth, redirectIfAuth };
