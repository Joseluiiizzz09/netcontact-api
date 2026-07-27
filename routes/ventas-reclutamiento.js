/* ================================================
   ROUTES/VENTAS-RECLUTAMIENTO.JS — MySQL
   Postulantes de Reclutamiento ("Nuevo Postulante" en dashboardreclutamiento.jsx).
   Mismo patrón técnico que routes/leads-reclutamiento.js: tabla propia,
   completamente aislada de `ventas` comercial — nunca se leen ni escriben ahí.
   Tras guardar en MySQL (fuente principal), se copia a Google Sheets de forma
   best-effort (utils/googleSheets.js) — un fallo de Sheets nunca revierte ni
   bloquea el guardado real.
   ================================================ */
const express = require('express');
const router  = express.Router();
const db      = require('../database');
const auth    = require('../middleware/auth');
const { validar, errorTexto } = require('../middleware/validar');
const { syncPostulanteToSheet } = require('../utils/googleSheets');

const ROLES_ALL   = ['backreclutamiento', 'jefatura', 'usuarios', 'asesorreclutamiento'];
const ROLES_ADMIN = ['backreclutamiento', 'jefatura', 'usuarios'];

// Un usuario con permiso delegado (no cargo primario) de un rol admin también
// debe verse como admin; cualquier otro caso (cargo o permiso asesorreclutamiento,
// delegado o no) queda escopado a lo suyo — evita que un permiso delegado sin
// rol admin real termine viendo/editando postulantes de otros.
function esAdminReclutamiento(user) {
  if (ROLES_ADMIN.includes(user.cargo)) return true;
  return Array.isArray(user.permisos) && user.permisos.some(p => ROLES_ADMIN.includes(p));
}

async function resolverPostulante(id) {
  const [rows] = await db.query(`
    SELECT v.*, u.nombre AS usuario_nombre
    FROM ventas_reclutamiento v
    LEFT JOIN usuarios u ON u.id = v.usuario_id
    WHERE v.id = ?
  `, [id]);
  return rows[0] || null;
}

// Guarda en Sheets sin bloquear la respuesta al frontend ni el registro ya
// confirmado en MySQL — si falla, solo se marca ERROR para reintento futuro.
async function sincronizarYMarcar(id) {
  const postulante = await resolverPostulante(id);
  if (!postulante) return;
  const resultado = await syncPostulanteToSheet(postulante);
  // Si Sheets no está configurado no es un error real — se deja en PENDING
  // (default) para no confundir un "aún no sincronizado" con una falla.
  if (resultado.motivo === 'not_configured') return;
  await db.query(
    `UPDATE ventas_reclutamiento SET sheets_sync_status = ?, sheets_synced_at = ? WHERE id = ?`,
    [resultado.ok ? 'SYNCED' : 'ERROR', resultado.ok ? new Date() : null, id]
  ).catch(err => console.error('[VENTAS-RECLUTAMIENTO] Error guardando sheets_sync_status:', err.message));
}

// GET /api/ventas-reclutamiento
router.get('/', auth(ROLES_ALL), async (req, res) => {
  try {
    const { asesor_id } = req.query;
    let sql = `
      SELECT v.*, v.campana AS fuente, u.nombre AS usuario_nombre
      FROM ventas_reclutamiento v
      LEFT JOIN usuarios u ON u.id = v.usuario_id
      WHERE 1=1
    `;
    const params = [];

    if (!esAdminReclutamiento(req.user)) {
      sql += ` AND v.usuario_id = ?`; params.push(req.user.id);
    } else if (asesor_id) {
      sql += ` AND v.usuario_id = ?`; params.push(asesor_id);
    }
    sql += ` ORDER BY v.created_at DESC`;

    const [data] = await db.query(sql, params);
    res.json({ ok: true, data });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener postulantes' });
  }
});

// POST /api/ventas-reclutamiento
router.post('/', auth(ROLES_ALL), async (req, res) => {
  try {
    const b = req.body || {};
    const errores = validar([
      errorTexto(b.nombre, 'nombre', { requerido: true, max: 150 }),
      errorTexto(b.dni, 'dni', { requerido: true, max: 20 }),
    ]);
    if (errores) return res.status(400).json({ ok: false, mensaje: errores[0] });

    const [result] = await db.query(`
      INSERT INTO ventas_reclutamiento
        (nombre, tipo_doc, dni, telefono1, telefono2, distrito, puesto, campana, empresa,
         experiencia, disponibilidad, estado_reclutamiento, fecha_entrevista, hora_entrevista,
         observacion, usuario_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      b.nombre.trim(), b.tipoDoc || 'DNI', b.dni.trim(), b.telefono1 || '', b.telefono2 || '',
      b.distrito || '', b.puesto || '', b.fuente || '', b.empresa || '',
      b.experiencia || '', b.disponibilidad || '', b.estadoReclutamiento || 'NUEVO',
      b.fechaEntrevista || null, b.horaEntrevista || '', b.obs || '', req.user.id,
    ]);

    res.json({ ok: true, id: result.insertId, mensaje: 'Postulante guardado' });
    sincronizarYMarcar(result.insertId).catch(err => console.error('[VENTAS-RECLUTAMIENTO] sync error:', err.message));
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al guardar postulante' });
  }
});

// PATCH /api/ventas-reclutamiento/:id
router.patch('/:id', auth(ROLES_ALL), async (req, res) => {
  try {
    const existente = await resolverPostulante(req.params.id);
    if (!existente) return res.status(404).json({ ok: false, mensaje: 'Postulante no encontrado' });
    if (!esAdminReclutamiento(req.user) && existente.usuario_id !== req.user.id)
      return res.status(403).json({ ok: false, mensaje: 'No puedes modificar postulantes de otro reclutador' });

    const b = req.body || {};
    const errores = validar([
      b.nombre !== undefined ? errorTexto(b.nombre, 'nombre', { requerido: true, max: 150 }) : null,
      b.dni    !== undefined ? errorTexto(b.dni, 'dni', { requerido: true, max: 20 })         : null,
    ]);
    if (errores) return res.status(400).json({ ok: false, mensaje: errores[0] });

    await db.query(`
      UPDATE ventas_reclutamiento SET
        nombre=?, tipo_doc=?, dni=?, telefono1=?, telefono2=?, distrito=?, puesto=?, campana=?,
        empresa=?, experiencia=?, disponibilidad=?, estado_reclutamiento=?, fecha_entrevista=?,
        hora_entrevista=?, observacion=?
      WHERE id=?
    `, [
      b.nombre ?? existente.nombre, b.tipoDoc ?? existente.tipo_doc, b.dni ?? existente.dni,
      b.telefono1 ?? existente.telefono1, b.telefono2 ?? existente.telefono2,
      b.distrito ?? existente.distrito, b.puesto ?? existente.puesto, b.fuente ?? existente.campana,
      b.empresa ?? existente.empresa, b.experiencia ?? existente.experiencia,
      b.disponibilidad ?? existente.disponibilidad, b.estadoReclutamiento ?? existente.estado_reclutamiento,
      b.fechaEntrevista ?? existente.fecha_entrevista, b.horaEntrevista ?? existente.hora_entrevista,
      b.obs ?? existente.observacion, req.params.id,
    ]);

    res.json({ ok: true, mensaje: 'Postulante actualizado' });
    sincronizarYMarcar(req.params.id).catch(err => console.error('[VENTAS-RECLUTAMIENTO] sync error:', err.message));
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar postulante' });
  }
});

module.exports = router;
