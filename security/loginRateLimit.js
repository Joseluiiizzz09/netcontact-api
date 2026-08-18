const rateLimit = require('express-rate-limit');

function loginKey(usuario) {
  return `usuario:${String(usuario || '').trim().toLowerCase()}`;
}

const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  // La empresa comparte una misma IP publica. El bloqueo pertenece a la
  // cuenta que acumula fallos, no a toda la oficina.
  keyGenerator: req => loginKey(req.body?.usuario),
  skipSuccessfulRequests: true,
  message: { ok: false, mensaje: 'Usuario bloqueado temporalmente por varios intentos fallidos. Intenta nuevamente en 5 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function desbloquearLogin(usuario) {
  loginLimiter.resetKey(loginKey(usuario));
}

module.exports = { loginLimiter, desbloquearLogin };
