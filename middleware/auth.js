const jwt = require('jsonwebtoken');
const db  = require('../database');

// Cache de estado activo: evita consultar la BD en cada request
// Cada entrada expira en 30 segundos — un usuario desactivado pierde acceso en max 30s
const _cacheActivo = new Map();
const CACHE_TTL = 30 * 1000;

async function verificarActivo(userId) {
  const ahora = Date.now();
  const cached = _cacheActivo.get(userId);
  if (cached && cached.expires > ahora) return cached.activo;

  const [rows] = await db.query(`SELECT activo FROM usuarios WHERE id = ?`, [userId]);
  const activo = rows.length ? !!rows[0].activo : false;
  _cacheActivo.set(userId, { activo, expires: ahora + CACHE_TTL });
  return activo;
}

module.exports = function auth(cargosPermitidos = []) {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, mensaje: 'No autorizado — falta token' });
    }

    const token = authHeader.split(' ')[1];

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      const activo = await verificarActivo(decoded.id);
      if (!activo) {
        return res.status(401).json({ ok: false, mensaje: 'Cuenta desactivada' });
      }

      req.user = decoded;

      if (cargosPermitidos.length > 0) {
        const cargoOk    = cargosPermitidos.includes(decoded.cargo);
        const permisosOk = decoded.permisos && decoded.permisos.some(p => cargosPermitidos.includes(p));
        if (!cargoOk && !permisosOk) {
          return res.status(403).json({ ok: false, mensaje: 'Sin permisos para esta acción' });
        }
      }

      next();
    } catch(e) {
      if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
        return res.status(401).json({ ok: false, mensaje: 'Token expirado o inválido' });
      }
      console.error('[AUTH ERROR]', e.message);
      return res.status(500).json({ ok: false, mensaje: 'Error de autenticación' });
    }
  };
};
