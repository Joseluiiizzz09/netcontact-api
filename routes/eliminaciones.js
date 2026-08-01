const express = require('express');
const router = express.Router();
const db = require('../database');
const auth = require('../middleware/auth');

router.get('/', auth(['jefatura']), async (_req, res) => {
  try {
    const [data] = await db.query(`
      SELECT id, actor_id, actor_nombre, actor_cargo, tipo, registro_id, detalle,
             snapshot_json, created_at
      FROM eliminaciones
      ORDER BY created_at DESC, id DESC
    `);
    res.json({ ok: true, data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener eliminaciones' });
  }
});

// DELETE /api/eliminaciones — limpieza total del historial, solo Jefatura.
router.delete('/', auth(['jefatura']), async (req, res) => {
  try {
    if (req.body?.confirmacion !== 'ELIMINAR') {
      return res.status(400).json({ ok: false, mensaje: 'Confirmación inválida' });
    }
    const [result] = await db.query(`DELETE FROM eliminaciones`);
    res.json({
      ok: true,
      eliminados: result.affectedRows,
      mensaje: `${result.affectedRows} registro(s) de eliminación borrado(s)`,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al limpiar el historial de eliminaciones' });
  }
});

module.exports = router;
