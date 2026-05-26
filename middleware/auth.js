/* ================================================
   MIDDLEWARE/AUTH.JS — Verificar JWT y cargos
   ================================================ */
const jwt = require('jsonwebtoken');

module.exports = function auth(cargosPermitidos = []) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, mensaje: 'No autorizado — falta token' });
    }

    const token = authHeader.split(' ')[1];

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
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
      return res.status(401).json({ ok: false, mensaje: 'Token expirado o inválido' });
    }
  };
};