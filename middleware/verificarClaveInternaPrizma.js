module.exports = function verificarClaveInternaPrizma(req, res, next) {
  const clave = req.headers['x-internal-key'];
  if (!clave || clave !== process.env.INTERNAL_PRIZMA_KEY) {
    return res.status(401).json({ ok: false, mensaje: 'Clave interna invalida o ausente' });
  }
  next();
};
