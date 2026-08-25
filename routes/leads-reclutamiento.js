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
const { validar, errorTexto, errorFecha, errorHora, errorHistorial, errorEnum } = require('../middleware/validar');

const ROLES_BACK = ['backreclutamiento', 'jefatura', 'usuarios'];
const ROLES_ALL  = ['backreclutamiento', 'jefatura', 'usuarios', 'asesorreclutamiento'];
const ROLES_ENTREVISTAS = ['entrevistas', 'backreclutamiento', 'jefatura', 'usuarios'];
const TURNOS_ENTREVISTA = ['TURNO 1', 'TURNO 2'];

let promesaTablaEntrevistas;
function asegurarTablaEntrevistas() {
  if (!promesaTablaEntrevistas) {
    promesaTablaEntrevistas = db.query(`
      CREATE TABLE IF NOT EXISTS reclutamiento_entrevistas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        lead_id INT NOT NULL,
        nombre_postulante VARCHAR(150) NOT NULL,
        numero VARCHAR(30) NOT NULL,
        numero_ref VARCHAR(30) NULL,
        turno VARCHAR(20) NOT NULL,
        fecha_agendamiento DATE NOT NULL,
        observacion VARCHAR(2000) NULL,
        creado_por_id INT NULL,
        creado_por_nombre VARCHAR(150) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_entrevistas_lead (lead_id),
        INDEX idx_entrevistas_fecha (fecha_agendamiento)
      )
    `).catch(error => { promesaTablaEntrevistas = null; throw error; });
  }
  return promesaTablaEntrevistas;
}

function normalizarN1(valor) {
  return String(valor || '').replace(/\D+/g, '');
}

function normalizarUsuarioWhatsapp(valor) {
  return String(valor || '').trim().replace(/^@+/, '').substring(0, 100);
}

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

    let sql = `SELECT l.*, ub.nombre AS creado_por_nombre FROM leads_reclutamiento l LEFT JOIN usuarios ub ON ub.id = l.usuario_back_id WHERE 1=1`;
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
      const n1Normalizado = normalizarN1(l.n1);
      const usuarioWhatsapp = normalizarUsuarioWhatsapp(l.usuario_whatsapp);
      const errores = validar([
        errorFecha(l.fecha || fechaHoy, 'fecha'),
        errorTexto(l.n1, 'n1', { max: 30 }),
        errorTexto(usuarioWhatsapp, 'usuario_whatsapp', { max: 100 }),
        errorTexto(l.tipif_back, 'tipif_back', { max: 100 }),
        errorTexto(l.obs_asesor, 'obs_asesor', { max: 2000 }),
      ]);
      if (errores) return res.status(400).json({ ok: false, mensaje: errores[0] });
      if (!n1Normalizado && !usuarioWhatsapp) {
        return res.status(400).json({ ok: false, mensaje: 'Ingresa un N1 o un usuario de WhatsApp' });
      }
    }

    for (const l of items) {
      const n1Normalizado = normalizarN1(l.n1);
      const usuarioWhatsapp = normalizarUsuarioWhatsapp(l.usuario_whatsapp);
      if (!n1Normalizado && !usuarioWhatsapp) continue;
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

      // hora_asig/historial: si vienen explicitos (ej. importacion Legacy con
      // fecha/hora reales del sistema anterior) se respetan tal cual, en vez de
      // sobreescribirlos con la hora actual como hacia el alta normal.
      const horaFinal = l.hora_asig || (asesorId ? horaAhora : '');
      const historial = Array.isArray(l.historial) && l.historial.length
        ? JSON.stringify(l.historial)
        : (asesorId
            ? JSON.stringify([{ asesor: asesorNombre, hora: horaFinal, fecha: fechaHoy, motivo: 'Asignacion inicial' }])
            : '[]');

      const [result] = await db.query(`
        INSERT INTO leads_reclutamiento
          (campana, departamento, provincia, distrito, n1, n2, usuario_whatsapp, tipif_back, obs_asesor, asesor_id, asesor_nombre,
           fecha, hora_asig, sin_asignar, historial, usuario_back_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [
        l.campana||'', l.departamento||'', l.provincia||'', l.distrito||'', l.n1||null, l.n2||null, usuarioWhatsapp||null,
        l.tipif_back||null, l.obs_asesor||null,
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

// PATCH /api/leads-reclutamiento/:id/datos-back — editar campaña/contacto de
// un candidato ya creado (campaña, N1, N2, usuario de WhatsApp).
router.patch('/:id/datos-back', auth(ROLES_BACK), async (req, res) => {
  try {
    const n1Normalizado = normalizarN1(req.body.n1);
    const usuarioWhatsapp = normalizarUsuarioWhatsapp(req.body.usuario_whatsapp);
    const errores = validar([
      errorTexto(req.body.campana, 'campana', { max: 100 }),
      errorTexto(req.body.n1, 'n1', { max: 30 }),
      errorTexto(usuarioWhatsapp, 'usuario_whatsapp', { max: 100 }),
    ]);
    if (errores) return res.status(400).json({ ok: false, mensaje: errores[0] });
    if (!n1Normalizado && !usuarioWhatsapp) {
      return res.status(400).json({ ok: false, mensaje: 'Ingresa un N1 o un usuario de WhatsApp' });
    }
    const [rows] = await db.query(`SELECT id FROM leads_reclutamiento WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Candidato no encontrado' });
    await db.query(`
      UPDATE leads_reclutamiento SET campana=?, n1=?, n2=?, usuario_whatsapp=? WHERE id=?
    `, [req.body.campana||'', req.body.n1||null, req.body.n2||null, usuarioWhatsapp||null, req.params.id]);
    res.json({ ok: true, mensaje: 'Candidato actualizado' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar candidato' });
  }
});

// DELETE /api/leads-reclutamiento/:id
router.delete('/:id', auth(ROLES_BACK), async (req, res) => {
  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();
    const [rows] = await conn.query(`SELECT * FROM leads_reclutamiento WHERE id = ? FOR UPDATE`, [req.params.id]);
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ ok: false, mensaje: 'Candidato no encontrado' });
    }
    const [actores] = await conn.query(`SELECT nombre, cargo FROM usuarios WHERE id = ? LIMIT 1`, [req.user.id]);
    const lead = rows[0];
    const actor = actores[0] || {};
    await conn.query(`DELETE FROM leads_reclutamiento WHERE id = ?`, [req.params.id]);
    await conn.query(
      `INSERT INTO eliminaciones
        (actor_id, actor_nombre, actor_cargo, tipo, registro_id, detalle, snapshot_json)
       VALUES (?, ?, ?, 'NUMERO_RECLUTAMIENTO', ?, ?, ?)`,
      [req.user.id, actor.nombre || 'Usuario', actor.cargo || req.user.cargo || '', String(req.params.id),
        `N1 ${lead.n1 || '—'} · N2 ${lead.n2 || '—'} · Asesor ${lead.asesor_nombre || 'Sin asignar'} · Fecha ${lead.fecha || '—'}`,
        JSON.stringify(lead)]
    );
    await conn.commit();
    res.json({ ok: true, mensaje: 'Candidato eliminado' });
  } catch(e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al eliminar candidato' });
  } finally {
    conn?.release();
  }
});

// POST /api/leads-reclutamiento/:id/entrevista — agenda una entrevista al
// tipificar un candidato como VENTA CERRADA ("Acepta propuesta").
router.post('/:id/entrevista', auth(ROLES_ALL), async (req, res) => {
  try {
    await asegurarTablaEntrevistas();
    const { nombre_postulante, numero, numero_ref, turno, fecha_agendamiento, observacion } = req.body;
    const errores = validar([
      errorTexto(nombre_postulante, 'nombre_postulante', { requerido: true, max: 150 }),
      errorTexto(numero, 'numero', { requerido: true, max: 30 }),
      errorTexto(numero_ref, 'numero_ref', { max: 30 }),
      errorTexto(turno, 'turno', { requerido: true, max: 20 }),
      errorEnum(turno, 'turno', TURNOS_ENTREVISTA),
      errorFecha(fecha_agendamiento, 'fecha_agendamiento'),
      errorTexto(observacion, 'observacion', { max: 2000 }),
    ]);
    if (errores) return res.status(400).json({ ok: false, mensaje: errores[0] });
    if (!fecha_agendamiento) return res.status(400).json({ ok: false, mensaje: 'fecha_agendamiento es obligatoria' });
    const [rows] = await db.query(`SELECT id FROM leads_reclutamiento WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Candidato no encontrado' });
    await db.query(`
      INSERT INTO reclutamiento_entrevistas
        (lead_id, nombre_postulante, numero, numero_ref, turno, fecha_agendamiento, observacion, creado_por_id, creado_por_nombre)
      VALUES (?,?,?,?,?,?,?,?,?)
    `, [req.params.id, nombre_postulante.trim(), numero.trim(), (numero_ref||'').trim()||null, turno, fecha_agendamiento,
        (observacion||'').trim()||null, req.user.id, req.user.nombre || req.user.usuario || 'Back Data']);
    res.json({ ok: true, mensaje: 'Entrevista agendada' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al agendar la entrevista' });
  }
});

// GET /api/leads-reclutamiento/entrevistas — listado para el apartado de Entrevistas
router.get('/entrevistas', auth(ROLES_ENTREVISTAS), async (req, res) => {
  try {
    await asegurarTablaEntrevistas();
    const [data] = await db.query(`
      SELECT e.id, e.nombre_postulante, e.numero, e.numero_ref, e.turno, e.fecha_agendamiento,
             e.observacion, e.creado_por_nombre, e.created_at,
             l.campana, l.n1 AS lead_n1, l.n2 AS lead_n2
        FROM reclutamiento_entrevistas e
        JOIN leads_reclutamiento l ON l.id = e.lead_id
       ORDER BY e.fecha_agendamiento DESC, e.id DESC
    `);
    res.json({ ok: true, data });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener entrevistas' });
  }
});

module.exports = router;
