/* ================================================
   ROUTES/LEADS.JS — MySQL
   ================================================ */
const express = require('express');
const router  = express.Router();
const db      = require('../database');
const auth    = require('../middleware/auth');

const ROLES_BO  = ['backoffice','jefatura','usuarios'];
const ROLES_ALL = ['backoffice','jefatura','usuarios','asesor','supervisor','supgrabaciones'];

function fechaPeruHoy() {
  const ahora = new Date();
  const peru  = new Date(ahora.getTime() + ahora.getTimezoneOffset()*60000 + (-5*60*60000));
  return peru.getFullYear()+'-'+String(peru.getMonth()+1).padStart(2,'0')+'-'+String(peru.getDate()).padStart(2,'0');
}
function horaPeruAhora() {
  const ahora = new Date();
  const peru  = new Date(ahora.getTime() + ahora.getTimezoneOffset()*60000 + (-5*60*60000));
  return String(peru.getHours()).padStart(2,'0')+':'+String(peru.getMinutes()).padStart(2,'0');
}

// GET /api/leads
router.get('/', auth(ROLES_ALL), async (req, res) => {
  try {
    const { fecha, asesor_id } = req.query;
    let sql = `SELECT l.*, u.nombre as asesor_nombre_db FROM leads l LEFT JOIN usuarios u ON l.asesor_id = u.id WHERE 1=1`;
    const params = [];

    if (req.user.cargo === 'asesor') {
      sql += ` AND l.asesor_id = ?`; params.push(req.user.id);
    } else if (asesor_id) {
      sql += ` AND l.asesor_id = ?`; params.push(asesor_id);
    }

    if (fecha) { sql += ` AND l.fecha = ?`; params.push(fecha); }
    sql += ` ORDER BY l.created_at DESC`;

    const [data] = await db.query(sql, params);
    res.json({ ok: true, data: data.map(l => ({
      ...l,
      historial: (() => { try { return JSON.parse(l.historial||'[]'); } catch(e){ return []; } })()
    }))});
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener leads' });
  }
});

// POST /api/leads
router.post('/', auth(ROLES_BO), async (req, res) => {
  try {
    const leads     = Array.isArray(req.body) ? req.body : [req.body];
    const fechaHoy  = fechaPeruHoy();
    const horaAhora = horaPeruAhora();
    let creados = 0;
    const ids = [];

    for (const l of leads) {
      if (!l.n1) continue;
      let asesorId = l.asesor_id || null;
      let asesorNombre = l.asesor_nombre || l.asesor || '';

      if (!asesorId && asesorNombre) {
        const [uRows] = await db.query(`SELECT id FROM usuarios WHERE nombre = ?`, [asesorNombre]);
        if (uRows.length) asesorId = uRows[0].id;
      }

      const horaFinal  = asesorId ? horaAhora : '';
      const historial  = asesorId
        ? JSON.stringify([{ asesor: asesorNombre, hora: horaFinal, fecha: fechaHoy, motivo: 'Asignacion inicial' }])
        : '[]';

      const [result] = await db.query(`
        INSERT INTO leads (campana, distrito, n1, n2, tipif_back, asesor_id, asesor_nombre, fecha, hora_asig, sin_asignar, historial)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        l.campana||'', l.distrito||'', l.n1, l.n2||null, l.tipif_back||'',
        asesorId, asesorNombre, fechaHoy, horaFinal, asesorId?0:1, historial
      ]);
      ids.push(result.insertId);
      creados++;
    }

    res.json({ ok: true, creados, ids, mensaje: `${creados} lead(s) creado(s)`, fecha_usada: fechaHoy });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al crear leads' });
  }
});

// PATCH /api/leads/:id
router.patch('/:id', auth(ROLES_BO), async (req, res) => {
  try {
    const { asesor_nombre, tipif_back, hora_asig, historial } = req.body;
    const [rows] = await db.query(`SELECT * FROM leads WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Lead no encontrado' });
    const lead = rows[0];

    let asesorId = null;
    if (asesor_nombre) {
      const [uRows] = await db.query(`SELECT id FROM usuarios WHERE nombre = ?`, [asesor_nombre]);
      if (uRows.length) asesorId = uRows[0].id;
    }

    const horaReal      = hora_asig || horaPeruAhora();
    const historialJSON = historial ? JSON.stringify(historial) : lead.historial;

    await db.query(`
      UPDATE leads SET asesor_id=?, asesor_nombre=?, tipif_back=?, hora_asig=?,
        sin_asignar=?, historial=?, rotaciones=rotaciones+?
      WHERE id=?
    `, [
      asesorId, asesor_nombre||'', tipif_back||lead.tipif_back,
      horaReal, asesorId?0:1, historialJSON,
      req.body.sumarRotacion?1:0, req.params.id
    ]);

    res.json({ ok: true, mensaje: 'Lead actualizado' });
  } catch(e) {
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar lead' });
  }
});

// PATCH /api/leads/:id/tipif
router.patch('/:id/tipif', auth(ROLES_ALL), async (req, res) => {
  try {
    const { tipif_vend } = req.body;
    const [rows] = await db.query(`SELECT id FROM leads WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Lead no encontrado' });
    await db.query(`UPDATE leads SET tipif_vend=?, tipif_hora=? WHERE id=?`, [tipif_vend||'', horaPeruAhora(), req.params.id]);
    res.json({ ok: true, mensaje: 'Tipificación guardada' });
  } catch(e) {
    res.status(500).json({ ok: false, mensaje: 'Error al guardar tipificación' });
  }
});

// PATCH /api/leads/:id/obs
router.patch('/:id/obs', auth(ROLES_ALL), async (req, res) => {
  try {
    const { obs } = req.body;
    const [rows] = await db.query(`SELECT id FROM leads WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Lead no encontrado' });
    await db.query(`UPDATE leads SET obs_asesor=? WHERE id=?`, [obs||'', req.params.id]);
    res.json({ ok: true, mensaje: 'Observacion guardada' });
  } catch(e) {
    res.status(500).json({ ok: false, mensaje: 'Error al guardar observación' });
  }
});

// DELETE /api/leads/:id
router.delete('/:id', auth(ROLES_BO), async (req, res) => {
  try {
    await db.query(`DELETE FROM leads WHERE id = ?`, [req.params.id]);
    res.json({ ok: true, mensaje: 'Lead eliminado' });
  } catch(e) {
    res.status(500).json({ ok: false, mensaje: 'Error al eliminar lead' });
  }
});

// DELETE /api/leads/fecha/:fecha
router.delete('/fecha/:fecha', auth(ROLES_BO), async (req, res) => {
  try {
    const [result] = await db.query(`DELETE FROM leads WHERE fecha = ?`, [req.params.fecha]);
    res.json({ ok: true, eliminados: result.affectedRows });
  } catch(e) {
    res.status(500).json({ ok: false, mensaje: 'Error al eliminar leads' });
  }
});

// GET /api/leads/fecha-peru
router.get('/fecha-peru', auth(ROLES_ALL), (req, res) => {
  res.json({ ok: true, fecha: fechaPeruHoy(), hora: horaPeruAhora() });
});

module.exports = router;