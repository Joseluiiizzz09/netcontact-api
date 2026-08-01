/* ================================================
   ROUTES/LEADS.JS — MySQL
   ================================================ */
const express = require('express');
const router  = express.Router();
const db      = require('../database');
const auth    = require('../middleware/auth');
const { validar, errorTexto, errorFecha, errorHora, errorHistorial } = require('../middleware/validar');

const ROLES_BO  = ['backoffice','jefatura','usuarios'];
const ROLES_ALL = ['backoffice','jefatura','usuarios','asesor','supervisor','supgrabaciones'];
const TIPIF_PROHIBIDAS_ASIGNACION = new Set(['NO TOCAR', 'FRAUDE']);

function tipificacionProhibida(valor) {
  return TIPIF_PROHIBIDAS_ASIGNACION.has(String(valor || '').trim().toUpperCase());
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

function normalizarN1(valor) {
  return String(valor || '').replace(/\D+/g, '');
}

// GET /api/leads
router.get('/', auth(ROLES_ALL), async (req, res) => {
  try {
    const { fecha, asesor_id } = req.query;

    const errGet = validar([errorFecha(fecha, 'fecha')]);
    if (errGet) return res.status(400).json({ ok: false, mensaje: errGet[0] });

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
    const leads = Array.isArray(req.body) ? req.body : [req.body];

    if (leads.length > 500)
      return res.status(400).json({ ok: false, mensaje: 'No se pueden crear más de 500 leads a la vez' });

    const fechaHoy  = fechaPeruHoy();
    const horaAhora = horaPeruAhora();
    let creados = 0;
    const ids = [];
    const fechasUsadas = [];

    // Validar todas las fechas antes de insertar para evitar lotes parciales.
    for (const l of leads) {
      const fechaLead = l.fecha || fechaHoy;
      const errores = validar([
        errorFecha(fechaLead, 'fecha'),
        errorTexto(l.n1, 'n1', { requerido: true, max: 30 }),
        errorTexto(l.tipo_contacto, 'tipo_contacto', { max: 20 }),
        errorTexto(l.direccion, 'direccion', { max: 1000 }),
        errorTexto(l.coordenadas, 'coordenadas', { max: 255 }),
        errorTexto(l.obs_back, 'obs_back', { max: 2000 }),
      ]);
      if (errores) return res.status(400).json({ ok: false, mensaje: errores[0] });
    }

    for (const l of leads) {
      if (!l.n1) continue;
      const fechaLead = l.fecha || fechaHoy;
      const n1Normalizado = normalizarN1(l.n1);

      // El alta individual solicita esta comprobacion. La carga masiva conserva
      // su flujo de vista previa y su opcion explicita de incluir duplicados.
      if (l.verificar_duplicado && n1Normalizado) {
        const [duplicados] = await db.query(`
          SELECT id, n1, fecha
          FROM leads
          WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(n1, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', '') = ?
          ORDER BY created_at DESC
          LIMIT 1
        `, [n1Normalizado]);
        if (duplicados.length) {
          return res.status(409).json({
            ok: false,
            duplicado: true,
            mensaje: `El N1 ${l.n1} ya existe en la fecha ${duplicados[0].fecha}`,
            existente: duplicados[0],
          });
        }
      }

      let asesorId = l.asesor_id || null;
      let asesorNombre = '';

      if (asesorId) {
        // El nombre se obtiene de la BD, no del body
        const [uRows] = await db.query(`SELECT nombre FROM usuarios WHERE id = ?`, [asesorId]);
        if (uRows.length) asesorNombre = uRows[0].nombre;
        else asesorId = null;
      } else if (l.asesor_nombre || l.asesor) {
        const nombreBuscar = l.asesor_nombre || l.asesor;
        const [uRows] = await db.query(`SELECT id, nombre FROM usuarios WHERE nombre = ?`, [nombreBuscar]);
        if (uRows.length) { asesorId = uRows[0].id; asesorNombre = uRows[0].nombre; }
      }

      const horaFinal  = asesorId ? horaAhora : '';
      const historial  = asesorId
        ? JSON.stringify([{ asesor: asesorNombre, hora: horaFinal, fecha: fechaHoy, motivo: 'Asignacion inicial' }])
        : '[]';

      const [result] = await db.query(`
        INSERT INTO leads (campana, distrito, n1, n2, tipo_contacto, direccion, coordenadas, obs_back, tipif_back, asesor_id, asesor_nombre, fecha, hora_asig, sin_asignar, historial)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        l.campana||'', l.distrito||'', l.n1, l.n2||null,
        l.tipo_contacto||'LLAMADA', l.direccion||'', l.coordenadas||'', l.obs_back||'', l.tipif_back||'',
        asesorId, asesorNombre, fechaLead, horaFinal, asesorId?0:1, historial
      ]);
      ids.push(result.insertId);
      fechasUsadas.push(fechaLead);
      creados++;
    }

    res.json({
      ok: true,
      creados,
      ids,
      mensaje: `${creados} lead(s) creado(s)`,
      fecha_usada: fechasUsadas[0] || fechaHoy,
      fechas_usadas: [...new Set(fechasUsadas)],
    });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al crear leads' });
  }
});

// PATCH /api/leads/:id/datos-back
// Datos descriptivos que Back Office prepara para el asesor.
router.patch('/:id/datos-back', auth(ROLES_BO), async (req, res) => {
  try {
    const { tipo_contacto, direccion, coordenadas, obs_back } = req.body;
    const errores = validar([
      errorTexto(tipo_contacto, 'tipo_contacto', { max: 20 }),
      errorTexto(direccion, 'direccion', { max: 1000 }),
      errorTexto(coordenadas, 'coordenadas', { max: 255 }),
      errorTexto(obs_back, 'obs_back', { max: 2000 }),
    ]);
    if (errores) return res.status(400).json({ ok: false, mensaje: errores[0] });

    const campos = [];
    const valores = [];
    if (tipo_contacto !== undefined) { campos.push('tipo_contacto=?'); valores.push(tipo_contacto || 'LLAMADA'); }
    if (direccion     !== undefined) { campos.push('direccion=?');     valores.push(direccion || ''); }
    if (coordenadas   !== undefined) { campos.push('coordenadas=?');   valores.push(coordenadas || ''); }
    if (obs_back      !== undefined) { campos.push('obs_back=?');      valores.push(obs_back || ''); }
    if (!campos.length) return res.status(400).json({ ok: false, mensaje: 'No hay datos para actualizar' });

    valores.push(req.params.id);
    const [result] = await db.query(`UPDATE leads SET ${campos.join(', ')} WHERE id=?`, valores);
    if (!result.affectedRows) return res.status(404).json({ ok: false, mensaje: 'Lead no encontrado' });
    res.json({ ok: true, mensaje: 'Datos de Back Office guardados' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al guardar datos de Back Office' });
  }
});

// PATCH /api/leads/:id
router.patch('/:id', auth(ROLES_BO), async (req, res) => {
  try {
    const { asesor_nombre, tipif_back, hora_asig, historial } = req.body;

    const errores = validar([
      errorHora(hora_asig, 'hora_asig'),
      errorHistorial(historial),
      errorTexto(tipif_back, 'tipif_back', { max: 200 }),
    ]);
    if (errores) return res.status(400).json({ ok: false, mensaje: errores[0] });

    const [rows] = await db.query(`SELECT * FROM leads WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Lead no encontrado' });
    const lead = rows[0];

    // Defensa del servidor: aunque un cliente antiguo o una selección pendiente
    // intente reasignarlo, estos números nunca pueden recibir otro asesor.
    if (asesor_nombre && tipificacionProhibida(lead.tipif_vend)) {
      return res.status(409).json({
        ok: false,
        mensaje: `Número prohibido: ${String(lead.tipif_vend).toUpperCase()}`,
      });
    }

    let asesorId = null;
    let asesorNombreReal = '';
    if (asesor_nombre) {
      const [uRows] = await db.query(`SELECT id, nombre FROM usuarios WHERE nombre = ?`, [asesor_nombre]);
      if (uRows.length) { asesorId = uRows[0].id; asesorNombreReal = uRows[0].nombre; }
    }

    const horaReal      = hora_asig || horaPeruAhora();
    const historialJSON = historial ? JSON.stringify(historial) : lead.historial;

    await db.query(`
      UPDATE leads SET asesor_id=?, asesor_nombre=?, tipif_back=?, hora_asig=?,
        sin_asignar=?, historial=?, rotaciones=rotaciones+?
      WHERE id=?
    `, [
      asesorId, asesorNombreReal, tipif_back||lead.tipif_back,
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
    if (tipif_vend && String(tipif_vend).length > 200)
      return res.status(400).json({ ok: false, mensaje: 'tipif_vend no puede superar 200 caracteres' });
    const [rows] = await db.query(`SELECT id, asesor_id FROM leads WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Lead no encontrado' });
    if (req.user.cargo === 'asesor' && rows[0].asesor_id !== req.user.id)
      return res.status(403).json({ ok: false, mensaje: 'No puedes tipificar leads de otros asesores' });
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
    if (obs && String(obs).length > 2000)
      return res.status(400).json({ ok: false, mensaje: 'obs_asesor no puede superar 2000 caracteres' });
    const [rows] = await db.query(`SELECT id, asesor_id FROM leads WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Lead no encontrado' });
    if (req.user.cargo === 'asesor' && rows[0].asesor_id !== req.user.id)
      return res.status(403).json({ ok: false, mensaje: 'No puedes modificar observaciones de leads de otros asesores' });
    await db.query(`UPDATE leads SET obs_asesor=? WHERE id=?`, [obs||'', req.params.id]);
    res.json({ ok: true, mensaje: 'Observacion guardada' });
  } catch(e) {
    res.status(500).json({ ok: false, mensaje: 'Error al guardar observación' });
  }
});

// DELETE /api/leads/:id
router.delete('/:id', auth(ROLES_BO), async (req, res) => {
  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();
    const [rows] = await conn.query(`
      SELECT l.*, u.nombre AS asesor_nombre_db
      FROM leads l LEFT JOIN usuarios u ON u.id = l.asesor_id
      WHERE l.id = ? FOR UPDATE
    `, [req.params.id]);
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ ok: false, mensaje: 'Lead no encontrado' });
    }
    const [actores] = await conn.query(`SELECT nombre, cargo FROM usuarios WHERE id = ? LIMIT 1`, [req.user.id]);
    const lead = rows[0];
    const actor = actores[0] || {};
    await conn.query(`DELETE FROM leads WHERE id = ?`, [req.params.id]);
    await conn.query(
      `INSERT INTO eliminaciones
        (actor_id, actor_nombre, actor_cargo, tipo, registro_id, detalle, snapshot_json)
       VALUES (?, ?, ?, 'NUMERO_BACKDATA', ?, ?, ?)`,
      [req.user.id, actor.nombre || 'Usuario', actor.cargo || req.user.cargo || '', String(req.params.id),
        `N1 ${lead.n1 || '—'} · N2 ${lead.n2 || '—'} · Asesor ${lead.asesor_nombre_db || lead.asesor_nombre || 'Sin asignar'} · Fecha ${lead.fecha || '—'}`,
        JSON.stringify(lead)]
    );
    await conn.commit();
    res.json({ ok: true, mensaje: 'Lead eliminado' });
  } catch(e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al eliminar lead' });
  } finally {
    conn?.release();
  }
});

// DELETE /api/leads/fecha/:fecha
router.delete('/fecha/:fecha', auth(ROLES_BO), async (req, res) => {
  let conn;
  try {
    conn = await db.getConnection();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.fecha))
      return res.status(400).json({ ok: false, mensaje: 'Formato de fecha inválido. Usa YYYY-MM-DD' });

    await conn.beginTransaction();
    const [leads] = await conn.query(`
      SELECT l.*, u.nombre AS asesor_nombre_db
      FROM leads l LEFT JOIN usuarios u ON u.id = l.asesor_id
      WHERE l.fecha = ? FOR UPDATE
    `, [req.params.fecha]);
    const [actores] = await conn.query(`SELECT nombre, cargo FROM usuarios WHERE id = ? LIMIT 1`, [req.user.id]);
    const actor = actores[0] || {};
    const [result] = await conn.query(`DELETE FROM leads WHERE fecha = ?`, [req.params.fecha]);
    for (const lead of leads) {
      await conn.query(
        `INSERT INTO eliminaciones
          (actor_id, actor_nombre, actor_cargo, tipo, registro_id, detalle, snapshot_json)
         VALUES (?, ?, ?, 'NUMERO_BACKDATA', ?, ?, ?)`,
        [req.user.id, actor.nombre || 'Usuario', actor.cargo || req.user.cargo || '', String(lead.id),
          `N1 ${lead.n1 || '—'} · N2 ${lead.n2 || '—'} · Asesor ${lead.asesor_nombre_db || lead.asesor_nombre || 'Sin asignar'} · Fecha ${lead.fecha || '—'}`,
          JSON.stringify(lead)]
      );
    }
    await conn.commit();
    res.json({ ok: true, eliminados: result.affectedRows });
  } catch(e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al eliminar leads' });
  } finally {
    conn?.release();
  }
});

// GET /api/leads/fecha-peru
router.get('/fecha-peru', auth(ROLES_ALL), (req, res) => {
  res.json({ ok: true, fecha: fechaPeruHoy(), hora: horaPeruAhora() });
});

module.exports = router;
