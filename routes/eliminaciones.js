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

// DELETE /api/eliminaciones/:id - elimina un registro de auditoria, solo Jefatura.
router.delete('/:id', auth(['jefatura']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, mensaje: 'ID inválido' });
    }

    const [result] = await db.query(`DELETE FROM eliminaciones WHERE id = ?`, [id]);
    if (!result.affectedRows) {
      return res.status(404).json({ ok: false, mensaje: 'Registro no encontrado' });
    }

    res.json({
      ok: true,
      mensaje: 'Registro eliminado del historial',
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al eliminar el registro del historial' });
  }
});

module.exports = router;
