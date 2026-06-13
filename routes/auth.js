/* ================================================
   ROUTES/AUTH.JS — MySQL
   ================================================ */
const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../database');

router.post('/login', async (req, res) => {
  try {
    const { usuario, password } = req.body;
    if (!usuario || !password)
      return res.status(400).json({ ok: false, mensaje: 'Usuario y contraseña son obligatorios' });

    const [rows] = await db.query(`
      SELECT id, nombre, usuario, password, cargo, sala, genero, activo, permisos
      FROM usuarios WHERE usuario = ?
    `, [usuario.trim().toLowerCase()]);

    if (!rows.length) return res.status(401).json({ ok: false, mensaje: 'Usuario o contraseña incorrectos' });
    const u = rows[0];
    if (!u.activo) return res.status(403).json({ ok: false, mensaje: 'Cuenta desactivada. Contacta a jefatura.' });

    const passwordOk = bcrypt.compareSync(password, u.password);
    if (!passwordOk) return res.status(401).json({ ok: false, mensaje: 'Usuario o contraseña incorrectos' });

    let permisos = [];
    try { permisos = JSON.parse(u.permisos || '[]'); } catch(e) {}

    const token = jwt.sign(
      { id: u.id, usuario: u.usuario, cargo: u.cargo, sala: u.sala, permisos },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      ok: true, token,
      usuario: { id: u.id, nombre: u.nombre, usuario: u.usuario, cargo: u.cargo, sala: u.sala||'', genero: u.genero||'M', permisos }
    });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error en el servidor' });
  }
});

router.get('/verificar', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ ok: false });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    res.json({ ok: true, usuario: decoded });
  } catch(e) {
    res.status(401).json({ ok: false, mensaje: 'Token expirado o inválido' });
  }
});

module.exports = router;