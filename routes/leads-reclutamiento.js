/* ================================================
   ROUTES/LEADS-RECLUTAMIENTO.JS — MySQL
   Mismo patrón técnico de routes/leads.js (Backoffice comercial), pero sobre
   tabla y roles propios de Reclutamiento. Datos completamente aislados de
   `leads`/`ventas` comerciales — nunca se leen ni escriben ahí.
   ================================================ */
const express = require('express');
const router  = express.Router();
const db      = require('../database');
const auth    = require('../middleware/auth');
const { validar, errorTexto, errorFecha, errorHora, errorHistorial } = require('../middleware/validar');

const ROLES_BACK = ['backreclutamiento', 'jefatura', 'usuarios'];
const ROLES_ALL  = ['backreclutamiento', 'jefatura', 'usuarios', 'asesorreclutamiento'];

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

// Verifica que el usuario destino realmente tenga el cargo asesorreclutamiento
// (principal o delegado vía permisos) antes de dejarlo recibir asignaciones.
async function esAsesorReclutamientoValido(usuarioId) {
  const [rows] = await db.query(`SELECT cargo, permisos, activo FROM usuarios WHERE id = ?`, [usuarioId]);
  if (!rows.length || !rows[0].activo) return false;
  if (rows[0].cargo === 'asesorreclutamiento') return true;
  try { return (JSON.parse(rows[0].permisos || '[]')).includes('asesorreclutamiento'); }
  catch { return false; }
}

// GET /api/leads-reclutamiento
router.get('/', auth(ROLES_ALL), async (req, res) => {
  try {
    const { fecha, asesor_id } = req.query;
    const errGet = validar([errorFecha(fecha, 'fecha')]);
    if (errGet) return res.status(400).json({ ok: false, mensaje: errGet[0] });

    let sql = `SELECT l.* FROM leads_reclutamiento l WHERE 1=1`;
    const params = [];

    if (req.user.cargo === 'asesorreclutamiento') {
      sql += ` AND l.asesor_id = ?`; params.push(req.user.id);
    } else if (asesor_id) {
      sql += ` AND l.asesor_id = ?`; params.push(asesor_id);
    }
    if (fecha) { sql += ` AND l.fecha = ?`; params.push(fecha); }
    sql += ` ORDER BY l.created_at DESC`;

    const [data] = await db.query(sql, params);
    res.json({ ok: true, data: data.map(l => ({
      ...l,
      historial: (() => { try { return JSON.parse(l.historial || '[]'); } catch { return []; } })(),
    })) });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener candidatos' });
  }
});

// POST /api/leads-reclutamiento (individual o batch, mismo formato que /api/leads)
router.post('/', auth(ROLES_BACK), async (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    if (items.length > 500) return res.status(400).json({ ok: false, mensaje: 'No se pueden crear más de 500 registros a la vez' });

    const fechaHoy  = fechaPeruHoy();
    const horaAhora = horaPeruAhora();
    let creados = 0;
    const ids = [];

    for (const l of items) {
      const errores = validar([
        errorFecha(l.fecha || fechaHoy, 'fecha'),
        errorTexto(l.n1, 'n1', { requerido: true, max: 30 }),
      ]);
      if (errores) return res.status(400).json({ ok: false, mensaje: errores[0] });
    }

    for (const l of items) {
      if (!l.n1) continue;
      const fechaLead = l.fecha || fechaHoy;

      let asesorId = null;
      let asesorNombre = '';
      const nombreBuscar = l.asesor_nombre || l.asesor;
      if (nombreBuscar) {
        const [uRows] = await db.query(`SELECT id, nombre, cargo, permisos, activo FROM usuarios WHERE nombre = ?`, [nombreBuscar]);
        if (uRows.length && await esAsesorReclutamientoValido(uRows[0].id)) {
          asesorId = uRows[0].id; asesorNombre = uRows[0].nombre;
        }
      }

      const horaFinal = asesorId ? horaAhora : '';
      const historial = asesorId
        ? JSON.stringify([{ asesor: asesorNombre, hora: horaFinal, fecha: fechaHoy, motivo: 'Asignacion inicial' }])
        : '[]';

      const [result] = await db.query(`
        INSERT INTO leads_reclutamiento
          (campana, departamento, provincia, distrito, n1, n2, asesor_id, asesor_nombre,
           fecha, hora_asig, sin_asignar, historial, usuario_back_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [
        l.campana||'', l.departamento||'', l.provincia||'', l.distrito||'', l.n1, l.n2||null,
        asesorId, asesorNombre, fechaLead, horaFinal, asesorId?0:1, historial, req.user.id,
      ]);
      ids.push(result.insertId);
      creados++;
    }

    res.json({ ok: true, creados, ids, mensaje: `${creados} candidato(s) creado(s)` });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al crear candidatos' });
  }
});

// PATCH /api/leads-reclutamiento/:id — reasignación / hora / historial / rotación
router.patch('/:id', auth(ROLES_BACK), async (req, res) => {
  try {
    const { asesor_nombre, hora_asig, historial } = req.body;
    const errores = validar([
      errorHora(hora_asig, 'hora_asig'),
      errorHistorial(historial),
    ]);
    if (errores) return res.status(400).json({ ok: false, mensaje: errores[0] });

    const [rows] = await db.query(`SELECT * FROM leads_reclutamiento WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Candidato no encontrado' });
    const lead = rows[0];

    let asesorId = null;
    let asesorNombreReal = '';
    if (asesor_nombre) {
      const [uRows] = await db.query(`SELECT id, nombre FROM usuarios WHERE nombre = ?`, [asesor_nombre]);
      if (uRows.length && await esAsesorReclutamientoValido(uRows[0].id)) {
        asesorId = uRows[0].id; asesorNombreReal = uRows[0].nombre;
      }
    }

    const horaReal      = hora_asig || horaPeruAhora();
    const historialJSON = historial ? JSON.stringify(historial) : lead.historial;

    await db.query(`
      UPDATE leads_reclutamiento SET asesor_id=?, asesor_nombre=?, hora_asig=?,
        sin_asignar=?, historial=?, rotaciones=rotaciones+?
      WHERE id=?
    `, [asesorId, asesorNombreReal, horaReal, asesorId?0:1, historialJSON, req.body.sumarRotacion?1:0, req.params.id]);

    res.json({ ok: true, mensaje: 'Candidato actualizado' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar candidato' });
  }
});

// PATCH /api/leads-reclutamiento/:id/tipif — tipificación del asesor
router.patch('/:id/tipif', auth(ROLES_ALL), async (req, res) => {
  try {
    const { tipif_vend } = req.body;
    if (tipif_vend && String(tipif_vend).length > 200)
      return res.status(400).json({ ok: false, mensaje: 'tipif_vend no puede superar 200 caracteres' });
    const [rows] = await db.query(`SELECT id, asesor_id FROM leads_reclutamiento WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Candidato no encontrado' });
    if (req.user.cargo === 'asesorreclutamiento' && rows[0].asesor_id !== req.user.id)
      return res.status(403).json({ ok: false, mensaje: 'No puedes tipificar candidatos de otros asesores' });
    await db.query(`UPDATE leads_reclutamiento SET tipif_vend=?, tipif_hora=? WHERE id=?`, [tipif_vend||'', horaPeruAhora(), req.params.id]);
    res.json({ ok: true, mensaje: 'Tipificación guardada' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al guardar tipificación' });
  }
});

// PATCH /api/leads-reclutamiento/:id/obs — observación del asesor
router.patch('/:id/obs', auth(ROLES_ALL), async (req, res) => {
  try {
    const { obs } = req.body;
    if (obs && String(obs).length > 2000)
      return res.status(400).json({ ok: false, mensaje: 'La observación no puede superar 2000 caracteres' });
    const [rows] = await db.query(`SELECT id, asesor_id FROM leads_reclutamiento WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Candidato no encontrado' });
    if (req.user.cargo === 'asesorreclutamiento' && rows[0].asesor_id !== req.user.id)
      return res.status(403).json({ ok: false, mensaje: 'No puedes modificar observaciones de candidatos de otros asesores' });
    await db.query(`UPDATE leads_reclutamiento SET obs_asesor=? WHERE id=?`, [obs||'', req.params.id]);
    res.json({ ok: true, mensaje: 'Observación guardada' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al guardar observación' });
  }
});

// PATCH /api/leads-reclutamiento/:id/datos-back — compatibilidad con la
// llamada existente en Backdatareclutamiento.jsx; sin campos comerciales
// (tipo_contacto/dirección/coordenadas/obs_back no existen en este módulo).
router.patch('/:id/datos-back', auth(ROLES_BACK), async (req, res) => {
  res.json({ ok: true, mensaje: 'Sin datos adicionales para este módulo' });
});

// DELETE /api/leads-reclutamiento/:id
router.delete('/:id', auth(ROLES_BACK), async (req, res) => {
  try {
    await db.query(`DELETE FROM leads_reclutamiento WHERE id = ?`, [req.params.id]);
    res.json({ ok: true, mensaje: 'Candidato eliminado' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al eliminar candidato' });
  }
});

module.exports = router;
