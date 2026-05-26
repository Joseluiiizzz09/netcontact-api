/* ================================================
   ROUTES/AUTH.JS — Login y verificación de token
   ================================================ */
const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../database');

router.post('/login', (req, res) => {
  const { usuario, password } = req.body;

  if (!usuario || !password) {
    return res.status(400).json({ ok: false, mensaje: 'Usuario y contraseña son obligatorios' });
  }

  const u = db.prepare(`
    SELECT id, nombre, usuario, password, cargo, sala, genero, activo, permisos
    FROM usuarios WHERE usuario = ?
  `).get(usuario.trim().toLowerCase());

  if (!u) return res.status(401).json({ ok: false, mensaje: 'Usuario o contraseña incorrectos' });
  if (!u.activo) return res.status(403).json({ ok: false, mensaje: 'Cuenta desactivada. Contacta a jefatura.' });

  const passwordOk = bcrypt.compareSync(password, u.password);
  if (!passwordOk) return res.status(401).json({ ok: false, mensaje: 'Usuario o contraseña incorrectos' });

  // Parsear permisos
  let permisos = [];
  try { permisos = JSON.parse(u.permisos || '[]'); } catch(e) {}

  const token = jwt.sign(
    { id: u.id, usuario: u.usuario, cargo: u.cargo, sala: u.sala, permisos },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );

  res.json({
    ok: true,
    token,
    usuario: {
      id:       u.id,
      nombre:   u.nombre,
      usuario:  u.usuario,
      cargo:    u.cargo,
      sala:     u.sala   || '',
      genero:   u.genero || 'M',
      permisos,
    }
  });
});

router.get('/verificar', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ ok: false });
  const token = auth.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    res.json({ ok: true, usuario: decoded });
  } catch(e) {
    res.status(401).json({ ok: false, mensaje: 'Token expirado o inválido' });
  }
});

module.exports = router;