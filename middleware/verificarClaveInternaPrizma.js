const crypto = require('crypto');

// Comparacion resistente a timing: una comparacion === normal corta apenas
// difiere el primer byte, filtrando cuantos caracteres iniciales acerto un
// atacante que mide la latencia de muchos intentos.
function coincideSeguro(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = function verificarClaveInternaPrizma(req, res, next) {
  const clave = req.headers['x-internal-key'];
  if (!clave || !coincideSeguro(clave, process.env.INTERNAL_PRIZMA_KEY)) {
    return res.status(401).json({ ok: false, mensaje: 'Clave interna invalida o ausente' });
  }
  next();
};
