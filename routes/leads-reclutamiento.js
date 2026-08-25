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
const ROLES_CAPACITACION = ['capacitador', 'backreclutamiento', 'jefatura', 'usuarios'];
const TIPIF_DIA_CAPACITACION = ['DESISTE', 'ASISTE', 'FALTA'];
const TIPIF_FINAL_CAPACITACION = ['INGRESO', 'ALTA', 'DESISTE', 'DESAPROBADO'];
const TURNOS_ENTREVISTA = ['TURNO 1', 'TURNO 2'];
const TIPIFICACIONES_ENTREVISTA = ['NO CONTESTA', 'DESISTE', 'REPROGRAMA', 'CORTA LLAMADA', 'ASISTE', 'EN CAMINO', 'FALTA'];

let promesaTablaEntrevistas;
function asegurarTablaEntrevistas() {
  if (!promesaTablaEntrevistas) {
    promesaTablaEntrevistas = (async () => {
      await db.query(`
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
      `);
      const [columnas] = await db.query('SHOW COLUMNS FROM reclutamiento_entrevistas');
      const existentes = new Set(columnas.map(c => c.Field));
      if (!existentes.has('tipificacion')) {
        await db.query(`ALTER TABLE reclutamiento_entrevistas ADD COLUMN tipificacion VARCHAR(30) NULL`);
      }
      // Fecha real en la que el postulante se acerca (distinta de fecha_agendamiento,
      // que es la fecha solicitada en el formulario original).
      if (!existentes.has('fecha_entrevista')) {
        await db.query(`ALTER TABLE reclutamiento_entrevistas ADD COLUMN fecha_entrevista DATE NULL`);
      }
    })().catch(error => { promesaTablaEntrevistas = null; throw error; });
  }
  return promesaTablaEntrevistas;
}

// Apartado de Capacitación: se llena al tipificar una entrevista como ASISTE.
let promesaTablaCapacitaciones;
function asegurarTablaCapacitaciones() {
  if (!promesaTablaCapacitaciones) {
    promesaTablaCapacitaciones = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS reclutamiento_capacitaciones (
          id INT AUTO_INCREMENT PRIMARY KEY,
          entrevista_id INT NULL,
          lead_id INT NULL,
          nombre_postulante VARCHAR(150) NOT NULL,
          numero VARCHAR(30) NOT NULL,
          fecha_inicio_capacitacion DATE NOT NULL,
          creado_por_id INT NULL,
          creado_por_nombre VARCHAR(150) NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_capacitaciones_lead (lead_id),
          INDEX idx_capacitaciones_entrevista (entrevista_id)
        )
      `);
      const [columnas] = await db.query('SHOW COLUMNS FROM reclutamiento_capacitaciones');
      const existentes = new Set(columnas.map(c => c.Field));
      // 5 días (2 de CAPA + 3 de OJT), cada uno con su propia tipificación
      // DESISTE/ASISTE/FALTA; más SALA y tipificación final (desde OJT).
      const nuevas = [
        ['dia1_tipif', 'VARCHAR(20) NULL'],
        ['dia2_tipif', 'VARCHAR(20) NULL'],
        ['dia3_tipif', 'VARCHAR(20) NULL'],
        ['dia4_tipif', 'VARCHAR(20) NULL'],
        ['dia5_tipif', 'VARCHAR(20) NULL'],
        ['sala', 'VARCHAR(60) NULL'],
        ['tipificacion_final', 'VARCHAR(20) NULL'],
      ];
      for (const [columna, definicion] of nuevas) {
        if (!existentes.has(columna)) await db.query(`ALTER TABLE reclutamiento_capacitaciones ADD COLUMN ${columna} ${definicion}`);
      }
    })().catch(error => { promesaTablaCapacitaciones = null; throw error; });
  }
  return promesaTablaCapacitaciones;
}

function normalizarN1(valor) {
  return String(valor || '').replace(/\D+/g, '');
}

function normalizarUsuarioWhatsapp(valor) {
  return String(valor || '').trim().replace(/^@+/, '').substring(0, 100);
}

// Deja constancia en el historial de cada tipificación (mismo patrón que
// registrarTipifEvent en routes/leads.js), para que el historial de
// asignaciones quede relacionado con las tipificaciones que se fueron
// registrando mientras cada asesor tuvo el número asignado.
function registrarTipifEvent(historial, asesor, tipif) {
  const eventos = historial.filter(h => h?.tipo === 'TIPIF_VEND');
  const ultimo = eventos[eventos.length - 1];
  if (ultimo && (ultimo.asesor || '') === (asesor || '') && (ultimo.tipif || '') === (tipif || '')) {
    return historial;
  }
  historial.push({ tipo:'TIPIF_VEND', asesor: asesor || '', tipif: tipif || '', ts: Date.now(), hora: horaPeruAhora(), fecha: fechaPeruHoy() });
  return historial;
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

    await asegurarTablaEntrevistas();
    // Última tipificación de entrevista por lead — señal para permitir la
    // rotación manual aunque el tipif_vend siga en "Acepta propuesta"
    // (postulante que no continuó y vuelve a escribir).
    let sql = `
      SELECT l.*, ub.nombre AS creado_por_nombre, ent.tipificacion AS entrevista_tipificacion
        FROM leads_reclutamiento l
        LEFT JOIN usuarios ub ON ub.id = l.usuario_back_id
        LEFT JOIN (
          SELECT e1.lead_id, e1.tipificacion
            FROM reclutamiento_entrevistas e1
            INNER JOIN (SELECT lead_id, MAX(id) AS max_id FROM reclutamiento_entrevistas GROUP BY lead_id) u
              ON u.lead_id = e1.lead_id AND u.max_id = e1.id
        ) ent ON ent.lead_id = l.id
       WHERE 1=1`;
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
    const [rows] = await db.query(`SELECT id, asesor_id, asesor_nombre, historial FROM leads_reclutamiento WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Candidato no encontrado' });
    if (req.user.cargo === 'asesorreclutamiento' && rows[0].asesor_id !== req.user.id)
      return res.status(403).json({ ok: false, mensaje: 'No puedes tipificar candidatos de otros asesores' });
    let historial = [];
    try { historial = JSON.parse(rows[0].historial || '[]'); } catch { historial = []; }
    registrarTipifEvent(historial, rows[0].asesor_nombre || '', String(tipif_vend||'').trim().toUpperCase());
    await db.query(`UPDATE leads_reclutamiento SET tipif_vend=?, tipif_hora=?, historial=? WHERE id=?`, [tipif_vend||'', horaPeruAhora(), JSON.stringify(historial), req.params.id]);
    res.json({ ok: true, mensaje: 'Tipificación guardada', historial });
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
    // LEFT JOIN a propósito: si el lead de origen se elimina de la Base, la
    // entrevista ya agendada debe seguir apareciendo en este listado (solo se
    // pierde el dato de campaña/N1/N2 del lead, no el registro de la entrevista).
    const [data] = await db.query(`
      SELECT e.id, e.nombre_postulante, e.numero, e.numero_ref, e.turno, e.fecha_agendamiento, e.fecha_entrevista,
             e.observacion, e.tipificacion, e.creado_por_nombre, e.created_at,
             l.campana, l.n1 AS lead_n1, l.n2 AS lead_n2
        FROM reclutamiento_entrevistas e
        LEFT JOIN leads_reclutamiento l ON l.id = e.lead_id
       ORDER BY e.fecha_agendamiento DESC, e.id DESC
    `);
    res.json({ ok: true, data });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener entrevistas' });
  }
});

// PATCH /api/leads-reclutamiento/entrevistas/:entrevistaId — tipificar el
// resultado de la entrevista y/o actualizar la observación.
router.patch('/entrevistas/:entrevistaId', auth(ROLES_ENTREVISTAS), async (req, res) => {
  try {
    await asegurarTablaEntrevistas();
    const { tipificacion, observacion, fecha_entrevista } = req.body;
    const errores = validar([
      errorEnum(tipificacion, 'tipificacion', TIPIFICACIONES_ENTREVISTA),
      errorTexto(observacion, 'observacion', { max: 2000 }),
      errorFecha(fecha_entrevista, 'fecha_entrevista'),
    ]);
    if (errores) return res.status(400).json({ ok: false, mensaje: errores[0] });
    const [rows] = await db.query(`SELECT id FROM reclutamiento_entrevistas WHERE id = ?`, [req.params.entrevistaId]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Entrevista no encontrada' });
    const campos = [];
    const valores = [];
    if (tipificacion !== undefined) { campos.push('tipificacion = ?'); valores.push(tipificacion || null); }
    if (observacion !== undefined) { campos.push('observacion = ?'); valores.push((observacion||'').trim() || null); }
    if (fecha_entrevista !== undefined) { campos.push('fecha_entrevista = ?'); valores.push(fecha_entrevista || null); }
    if (!campos.length) return res.status(400).json({ ok: false, mensaje: 'Nada que actualizar' });
    valores.push(req.params.entrevistaId);
    await db.query(`UPDATE reclutamiento_entrevistas SET ${campos.join(', ')} WHERE id = ?`, valores);
    res.json({ ok: true, mensaje: 'Entrevista actualizada' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar la entrevista' });
  }
});

// POST /api/leads-reclutamiento/entrevistas/:entrevistaId/capacitacion — se
// crea al tipificar la entrevista como ASISTE.
router.post('/entrevistas/:entrevistaId/capacitacion', auth(ROLES_ENTREVISTAS), async (req, res) => {
  try {
    await asegurarTablaCapacitaciones();
    const { nombre_postulante, numero, fecha_inicio_capacitacion } = req.body;
    const errores = validar([
      errorTexto(nombre_postulante, 'nombre_postulante', { requerido: true, max: 150 }),
      errorTexto(numero, 'numero', { requerido: true, max: 30 }),
      errorFecha(fecha_inicio_capacitacion, 'fecha_inicio_capacitacion'),
    ]);
    if (errores) return res.status(400).json({ ok: false, mensaje: errores[0] });
    if (!fecha_inicio_capacitacion) return res.status(400).json({ ok: false, mensaje: 'fecha_inicio_capacitacion es obligatoria' });
    const [rows] = await db.query(`SELECT id, lead_id FROM reclutamiento_entrevistas WHERE id = ?`, [req.params.entrevistaId]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Entrevista no encontrada' });
    await db.query(`
      INSERT INTO reclutamiento_capacitaciones
        (entrevista_id, lead_id, nombre_postulante, numero, fecha_inicio_capacitacion, creado_por_id, creado_por_nombre)
      VALUES (?,?,?,?,?,?,?)
    `, [req.params.entrevistaId, rows[0].lead_id, nombre_postulante.trim(), numero.trim(), fecha_inicio_capacitacion,
        req.user.id, req.user.nombre || req.user.usuario || 'Back Data']);
    res.json({ ok: true, mensaje: 'Capacitación registrada' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al registrar la capacitación' });
  }
});

// GET /api/leads-reclutamiento/capacitaciones — listado para el apartado de Capacitación
router.get('/capacitaciones', auth(ROLES_CAPACITACION), async (req, res) => {
  try {
    await asegurarTablaCapacitaciones();
    const [data] = await db.query(`
      SELECT c.id, c.nombre_postulante, c.numero, c.fecha_inicio_capacitacion, c.creado_por_nombre, c.created_at,
             c.dia1_tipif, c.dia2_tipif, c.dia3_tipif, c.dia4_tipif, c.dia5_tipif, c.sala, c.tipificacion_final,
             l.campana
        FROM reclutamiento_capacitaciones c
        LEFT JOIN leads_reclutamiento l ON l.id = c.lead_id
       ORDER BY c.fecha_inicio_capacitacion DESC, c.id DESC
    `);
    res.json({ ok: true, data });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener capacitaciones' });
  }
});

// PATCH /api/leads-reclutamiento/capacitaciones/:capacitacionId — tipificar
// los 5 días (CAPA/OJT), asignar sala y la tipificación final. Nombre, número
// y fecha de inicio quedan fijos una vez registrados: no se editan aquí.
router.patch('/capacitaciones/:capacitacionId', auth(ROLES_CAPACITACION), async (req, res) => {
  try {
    await asegurarTablaCapacitaciones();
    const { dia1_tipif, dia2_tipif, dia3_tipif, dia4_tipif, dia5_tipif, sala, tipificacion_final } = req.body;
    const errores = validar([
      errorEnum(dia1_tipif, 'dia1_tipif', TIPIF_DIA_CAPACITACION),
      errorEnum(dia2_tipif, 'dia2_tipif', TIPIF_DIA_CAPACITACION),
      errorEnum(dia3_tipif, 'dia3_tipif', TIPIF_DIA_CAPACITACION),
      errorEnum(dia4_tipif, 'dia4_tipif', TIPIF_DIA_CAPACITACION),
      errorEnum(dia5_tipif, 'dia5_tipif', TIPIF_DIA_CAPACITACION),
      errorTexto(sala, 'sala', { max: 60 }),
      errorEnum(tipificacion_final, 'tipificacion_final', TIPIF_FINAL_CAPACITACION),
    ]);
    if (errores) return res.status(400).json({ ok: false, mensaje: errores[0] });
    const [rows] = await db.query(`SELECT id FROM reclutamiento_capacitaciones WHERE id = ?`, [req.params.capacitacionId]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Capacitación no encontrada' });
    const campos = [];
    const valores = [];
    if (dia1_tipif !== undefined) { campos.push('dia1_tipif = ?'); valores.push(dia1_tipif || null); }
    if (dia2_tipif !== undefined) { campos.push('dia2_tipif = ?'); valores.push(dia2_tipif || null); }
    if (dia3_tipif !== undefined) { campos.push('dia3_tipif = ?'); valores.push(dia3_tipif || null); }
    if (dia4_tipif !== undefined) { campos.push('dia4_tipif = ?'); valores.push(dia4_tipif || null); }
    if (dia5_tipif !== undefined) { campos.push('dia5_tipif = ?'); valores.push(dia5_tipif || null); }
    if (sala !== undefined) { campos.push('sala = ?'); valores.push((sala||'').trim() || null); }
    if (tipificacion_final !== undefined) { campos.push('tipificacion_final = ?'); valores.push(tipificacion_final || null); }
    if (!campos.length) return res.status(400).json({ ok: false, mensaje: 'Nada que actualizar' });
    valores.push(req.params.capacitacionId);
    await db.query(`UPDATE reclutamiento_capacitaciones SET ${campos.join(', ')} WHERE id = ?`, valores);
    res.json({ ok: true, mensaje: 'Capacitación actualizada' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar la capacitación' });
  }
});

module.exports = router;
