/* ================================================
   ROUTES/LEADS.JS — Base de llamadas
   ================================================ */
const express = require('express');
const router  = express.Router();
const db      = require('../database');
const auth    = require('../middleware/auth');

const ROLES_BO  = ['backoffice','jefatura','usuarios'];
const ROLES_ALL = ['backoffice','jefatura','usuarios','asesor','supervisor','supgrabaciones'];

/* Fecha actual en zona horaria Peru UTC-5 */
function fechaPeruHoy() {
  const ahora = new Date();
  // Offset Peru: UTC-5 = -300 minutos
  const peruOffset = -5 * 60;
  const utcMs = ahora.getTime() + ahora.getTimezoneOffset() * 60000;
  const peruMs = utcMs + peruOffset * 60000;
  const peru = new Date(peruMs);
  const y = peru.getFullYear();
  const m = String(peru.getMonth() + 1).padStart(2, '0');
  const d = String(peru.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function horaPeruAhora() {
  const ahora = new Date();
  const peruOffset = -5 * 60;
  const utcMs = ahora.getTime() + ahora.getTimezoneOffset() * 60000;
  const peruMs = utcMs + peruOffset * 60000;
  const peru = new Date(peruMs);
  const h = String(peru.getHours()).padStart(2, '0');
  const min = String(peru.getMinutes()).padStart(2, '0');
  return `${h}:${min}`;
}

try {
  // Migración: agregar columna obs_asesor si no existe
  try { db.exec(`ALTER TABLE leads ADD COLUMN obs_asesor TEXT DEFAULT ''`); } catch(e) {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      campana       TEXT DEFAULT '—',
      distrito      TEXT DEFAULT '—',
      n1            TEXT NOT NULL,
      n2            TEXT,
      tipif_back    TEXT DEFAULT '',
      asesor_id     INTEGER REFERENCES usuarios(id),
      asesor_nombre TEXT,
      fecha         TEXT NOT NULL,
      hora_asig     TEXT DEFAULT '',
      rotaciones    INTEGER DEFAULT 0,
      sin_asignar   INTEGER DEFAULT 1,
      tipif_vend    TEXT DEFAULT '',
      tipif_hora    TEXT DEFAULT '',
      obs_asesor    TEXT DEFAULT '',
      historial     TEXT DEFAULT '[]',
      created_at    TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
} catch(e) {}

// GET /api/leads
router.get('/', auth(ROLES_ALL), (req, res) => {
  const { fecha, asesor_id } = req.query;
  let sql = `SELECT l.*, u.nombre as asesor_nombre_db FROM leads l LEFT JOIN usuarios u ON l.asesor_id = u.id WHERE 1=1`;
  const params = [];

  if (req.user.cargo === 'asesor') {
    sql += ` AND l.asesor_id = ?`;
    params.push(req.user.id);
  } else if (asesor_id) {
    sql += ` AND l.asesor_id = ?`;
    params.push(asesor_id);
  }

  if (fecha) { sql += ` AND l.fecha = ?`; params.push(fecha); }
  sql += ` ORDER BY l.created_at DESC`;

  const data = db.prepare(sql).all(...params);
  res.json({ ok: true, data: data.map(l => ({
    ...l,
    historial: (() => { try { return JSON.parse(l.historial||'[]'); } catch(e){ return []; } })()
  }))});
});

// POST /api/leads
router.post('/', auth(ROLES_BO), (req, res) => {
  const leads = Array.isArray(req.body) ? req.body : [req.body];
  let creados = 0;
  const stmt = db.prepare(`
    INSERT INTO leads (campana, distrito, n1, n2, tipif_back, asesor_id, asesor_nombre, fecha, hora_asig, sin_asignar, historial)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Siempre usar fecha Peru del servidor — ignorar la fecha que mande el frontend
  const fechaHoy = fechaPeruHoy();
  const horaAhora = horaPeruAhora();

  for (const l of leads) {
    if (!l.n1) continue;
    let asesorId = l.asesor_id || null;
    let asesorNombre = l.asesor_nombre || l.asesor || '';
    if (!asesorId && asesorNombre) {
      const u = db.prepare(`SELECT id FROM usuarios WHERE nombre = ?`).get(asesorNombre);
      if (u) asesorId = u.id;
    }
    // Usar fecha Peru del servidor, no la del cliente
    const fechaFinal = fechaHoy;
    const horaFinal  = asesorId ? horaAhora : '';
    const historial  = asesorId
      ? JSON.stringify([{ asesor: asesorNombre, hora: horaFinal, fecha: fechaFinal, motivo: 'Asignacion inicial' }])
      : '[]';

    stmt.run(
      l.campana || '—',
      l.distrito || '—',
      l.n1,
      l.n2 || null,
      l.tipif_back || '',
      asesorId,
      asesorNombre,
      fechaFinal,
      horaFinal,
      asesorId ? 0 : 1,
      historial
    );
    creados++;
  }

  const stmt2 = db.prepare('SELECT id FROM leads ORDER BY id DESC LIMIT ?');
  res.json({
    ok: true,
    creados,
    ids: stmt2.all(creados).map(r => r.id).reverse(),
    mensaje: `${creados} lead(s) creado(s)`,
    fecha_usada: fechaHoy  // para debug
  });
});

// PATCH /api/leads/:id
router.patch('/:id', auth(ROLES_BO), (req, res) => {
  const { asesor_nombre, tipif_back, hora_asig, historial } = req.body;
  const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(req.params.id);
  if (!lead) return res.status(404).json({ ok: false, mensaje: 'Lead no encontrado' });

  let asesorId = null;
  if (asesor_nombre) {
    const u = db.prepare(`SELECT id FROM usuarios WHERE nombre = ?`).get(asesor_nombre);
    if (u) asesorId = u.id;
  }

  // Usar hora Peru para la asignación
  const horaReal = hora_asig || horaPeruAhora();
  const historialJSON = historial ? JSON.stringify(historial) : lead.historial;

  db.prepare(`
    UPDATE leads
    SET asesor_id=?, asesor_nombre=?, tipif_back=?, hora_asig=?,
        sin_asignar=?, historial=?, rotaciones=rotaciones+?
    WHERE id=?
  `).run(
    asesorId,
    asesor_nombre || '',
    tipif_back || lead.tipif_back,
    horaReal,
    asesorId ? 0 : 1,
    historialJSON,
    req.body.sumarRotacion ? 1 : 0,
    req.params.id
  );

  res.json({ ok: true, mensaje: 'Lead actualizado' });
});

// PATCH /api/leads/:id/tipif  — tipificación del vendedor
router.patch('/:id/tipif', auth(ROLES_ALL), (req, res) => {
  const { tipif_vend } = req.body;
  const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(req.params.id);
  if (!lead) return res.status(404).json({ ok: false, mensaje: 'Lead no encontrado' });

  db.prepare(`UPDATE leads SET tipif_vend=?, tipif_hora=? WHERE id=?`)
    .run(tipif_vend || '', horaPeruAhora(), req.params.id);

  res.json({ ok: true, mensaje: 'Tipificación guardada' });
});

// DELETE /api/leads/:id
router.delete('/:id', auth(ROLES_BO), (req, res) => {
  db.prepare(`DELETE FROM leads WHERE id = ?`).run(req.params.id);
  res.json({ ok: true, mensaje: 'Lead eliminado' });
});

// DELETE /api/leads/fecha/:fecha
router.delete('/fecha/:fecha', auth(ROLES_BO), (req, res) => {
  const info = db.prepare(`DELETE FROM leads WHERE fecha = ?`).run(req.params.fecha);
  res.json({ ok: true, eliminados: info.changes });
});

// PATCH /api/leads/:id/obs — observacion del asesor (DNI, nota)
router.patch('/:id/obs', auth(ROLES_ALL), (req, res) => {
  const { obs } = req.body;
  const lead = db.prepare(`SELECT id FROM leads WHERE id = ?`).get(req.params.id);
  if (!lead) return res.status(404).json({ ok: false, mensaje: 'Lead no encontrado' });
  db.prepare(`UPDATE leads SET obs_asesor=? WHERE id=?`).run(obs || '', req.params.id);
  res.json({ ok: true, mensaje: 'Observacion guardada' });
});

// GET /api/leads/fecha-peru — util para debug
router.get('/fecha-peru', auth(ROLES_ALL), (req, res) => {
  res.json({ ok: true, fecha: fechaPeruHoy(), hora: horaPeruAhora() });
});

module.exports = router;