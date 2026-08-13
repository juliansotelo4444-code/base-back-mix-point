const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'cambiar-este-secreto-en-produccion';

function requireAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado. Falta token.' });
    }
    const token = header.split(' ')[1];
    try {
        const payload = jwt.verify(token, SECRET);
        req.usuario = payload;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Token inválido o expirado.' });
    }
}

// Restringe una ruta a ciertos roles. Uso: requireRole('admin', 'administracion')
function requireRole(...rolesPermitidos) {
    return (req, res, next) => {
        if (!req.usuario || !rolesPermitidos.includes(req.usuario.rol)) {
            return res.status(403).json({ error: 'No tenés permisos para esta acción.' });
        }
        next();
    };
}

module.exports = { requireAuth, requireRole, SECRET };
