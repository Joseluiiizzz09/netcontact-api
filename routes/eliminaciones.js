const express = require('express');
const router = express.Router();
const db = require('../database');
const auth = require('../middleware/auth');

router.get('/', auth(['jefatura']), async (_req, res) => {
  try {
    const [data] = await db.query(`
      SELECT id, actor_id, actor_nombre, actor_cargo, tipo, registro_id, detalle,
             snapshot_json, created_at, restored_at, restored_by_id, restored_by_nombre
      FROM eliminaciones
      ORDER BY created_at DESC, id DESC
    `);
    res.json({ ok: true, data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener eliminaciones' });
  }
});

// POST /api/eliminaciones/:id/restablecer - recupera una venta desde su snapshot.
router.post('/:id/restablecer', auth(['jefatura']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, mensaje: 'ID inválido' });
    }

    await conn.beginTransaction();
    const [registros] = await conn.query(
      `SELECT * FROM eliminaciones WHERE id = ? FOR UPDATE`,
      [id]
    );
    const eliminacion = registros[0];
    if (!eliminacion) {
      await conn.rollback();
      return res.status(404).json({ ok: false, mensaje: 'Registro de eliminación no encontrado' });
    }
    if (eliminacion.tipo !== 'VENTA') {
      await conn.rollback();
      return res.status(400).json({ ok: false, mensaje: 'Este tipo de registro todavía no admite restauración' });
    }
    if (eliminacion.restored_at) {
      await conn.rollback();
      return res.status(409).json({ ok: false, mensaje: 'Esta venta ya fue restablecida' });
    }

    let snapshot;
    try { snapshot = JSON.parse(eliminacion.snapshot_json || '{}'); }
    catch {
      await conn.rollback();
      return res.status(422).json({ ok: false, mensaje: 'La copia de la venta está dañada' });
    }
    const ventaId = Number(snapshot.id || eliminacion.registro_id);
    if (!Number.isInteger(ventaId) || ventaId <= 0) {
      await conn.rollback();
      return res.status(422).json({ ok: false, mensaje: 'La copia no contiene un ID de venta válido' });
    }
    const [existentes] = await conn.query(`SELECT id FROM ventas WHERE id = ? LIMIT 1`, [ventaId]);
    if (existentes.length) {
      await conn.rollback();
      return res.status(409).json({ ok: false, mensaje: 'La venta ya existe y no se sobrescribió' });
    }

    const [columnasDb] = await conn.query(`SHOW COLUMNS FROM ventas`);
    const permitidas = new Set(columnasDb.map(col => col.Field));
    const columnas = Object.keys(snapshot).filter(campo => permitidas.has(campo));
    if (!columnas.includes('id')) columnas.unshift('id');
    const fila = { ...snapshot, id: ventaId };

    if (fila.asesor_id) {
      const [asesores] = await conn.query(`SELECT id FROM usuarios WHERE id = ? LIMIT 1`, [fila.asesor_id]);
      if (!asesores.length) fila.asesor_id = null;
    }
    const valores = columnas.map(campo => fila[campo] === undefined ? null : fila[campo]);
    const marcadores = columnas.map(() => '?').join(', ');
    const nombres = columnas.map(campo => `\`${campo}\``).join(', ');
    await conn.query(`INSERT INTO ventas (${nombres}) VALUES (${marcadores})`, valores);

    await conn.query(
      `UPDATE eliminaciones
          SET restored_at = NOW(), restored_by_id = ?, restored_by_nombre = ?
        WHERE id = ?`,
      [req.user.id, req.user.nombre || 'Jefatura', id]
    );
    await conn.commit();
    res.json({ ok: true, mensaje: `Venta ${ventaId} restablecida correctamente`, venta_id: ventaId });
  } catch (e) {
    await conn.rollback().catch(() => {});
    console.error('[POST /eliminaciones/:id/restablecer]', e);
    res.status(500).json({ ok: false, mensaje: 'Error al restablecer la venta' });
  } finally {
    conn.release();
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
