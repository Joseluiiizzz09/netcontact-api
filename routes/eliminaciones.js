const express = require('express');
const router = express.Router();
const db = require('../database');
const auth = require('../middleware/auth');

router.get('/', auth(['jefatura']), async (_req, res) => {
  try {
    const [data] = await db.query(`
      SELECT id, actor_id, actor_nombre, actor_cargo, tipo, registro_id, detalle, created_at
      FROM eliminaciones
      ORDER BY created_at DESC, id DESC
      LIMIT 500
    `);
    res.json({ ok: true, data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener eliminaciones' });
  }
});

module.exports = router;
