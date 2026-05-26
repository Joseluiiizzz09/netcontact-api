/* ================================================
   ROUTES/LEADS.JS — Base de llamadas
   ================================================ */
const express = require('express');
const router  = express.Router();
const db      = require('../database');
const auth    = require('../middleware/auth');

const ROLES_BO = ['backoffice','jefatura','usuarios'];
const ROLES_ALL = ['backoffice','jefatura','usuarios','asesor','supervisor'];

// Crear tabla si no existe
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      campana     TEXT DEFAULT '—',
      distrito    TEXT DEFAULT '—',
      n1          TEXT NOT NULL,
      n2          TEXT,
      tipif_back  TEXT DEFAULT '',
      asesor_id   INTEGER REFERENCES usuarios(id),
      asesor_nombre TEXT,
      fecha       TEXT NOT NULL,
      hora_asig   TEXT DEFAULT '',
      rotaciones  INTEGER DEFAULT 0,
      sin_asignar INTEGER DEFAULT 1,
      tipif_vend  TEXT DEFAULT '',
      tipif_hora  TEXT DEFAULT '',
      historial   TEXT DEFAULT '[]',
      created_at  TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
} catch(e) {}

// GET /api/leads — obtener todos (backoffice) o solo los del asesor
router.get('/', auth(ROLES_ALL), (req, res) => {
  const { fecha, asesor_id } = req.query;
  let sql = `SELECT l.*, u.nombre as asesor_nombre_db FROM leads l LEFT JOIN usuarios u ON l.asesor_id = u.id WHERE 1=1`;
  const params = [];

  // Asesor solo ve sus propios leads
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

// POST /api/leads — crear uno o varios leads
router.post('/', auth(ROLES_BO), (req, res) => {
  const leads = Array.isArray(req.body) ? req.body : [req.body];
  let creados = 0;

  const stmt = db.prepare(`
    INSERT INTO leads (campana, distrito, n1, n2, tipif_back, asesor_id, asesor_nombre, fecha, hora_asig, sin_asignar, historial)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const l of leads) {
    if (!l.n1) continue;
    // Buscar asesor_id si viene nombre
    let asesorId = l.asesor_id || null;
    let asesorNombre = l.asesor_nombre || l.asesor || '';
    if (!asesorId && asesorNombre) {
      const u = db.prepare(`SELECT id FROM usuarios WHERE nombre = ?`).get(asesorNombre);
      if (u) asesorId = u.id;
    }
    const historial = asesorId ? JSON.stringify([{
      asesor: asesorNombre, hora: l.hora_asig || '', fecha: l.fecha, motivo: 'Asignación inicial'
    }]) : '[]';
    stmt.run(
      l.campana || '—', l.distrito || '—', l.n1, l.n2 || null,
      l.tipif_back || '', asesorId, asesorNombre,
      l.fecha, l.hora_asig || '', asesorId ? 0 : 1, historial
    );
    creados++;
  }

  const ids = [];
  const stmt2 = db.prepare('SELECT id FROM leads ORDER BY id DESC LIMIT ?');
  res.json({ ok: true, creados, ids: stmt2.all(creados).map(r=>r.id).reverse(), mensaje: `${creados} lead(s) creado(s)` });
});

// PATCH /api/leads/:id — actualizar asesor, tipif, etc.
router.patch('/:id', auth(ROLES_BO), (req, res) => {
  const { asesor_nombre, tipif_back, hora_asig, historial } = req.body;
  const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(req.params.id);
  if (!lead) return res.status(404).json({ ok: false, mensaje: 'Lead no encontrado' });

  let asesorId = null;
  if (asesor_nombre) {
    const u = db.prepare(`SELECT id FROM usuarios WHERE nombre = ?`).get(asesor_nombre);
    if (u) asesorId = u.id;
  }

  const historialJSON = historial ? JSON.stringify(historial) : lead.historial;

  db.prepare(`
    UPDATE leads SET
      asesor_id = ?, asesor_nombre = ?, tipif_back = ?,
      hora_asig = ?, sin_asignar = ?, historial = ?,
      rotaciones = rotaciones + ?
    WHERE id = ?
  `).run(
    asesorId, asesor_nombre || '', tipif_back || lead.tipif_back,
    hora_asig || lead.hora_asig, asesorId ? 0 : 1, historialJSON,
    req.body.sumarRotacion ? 1 : 0,
    req.params.id
  );

  res.json({ ok: true, mensaje: 'Lead actualizado' });
});

// DELETE /api/leads/:id
router.delete('/:id', auth(ROLES_BO), (req, res) => {
  db.prepare(`DELETE FROM leads WHERE id = ?`).run(req.params.id);
  res.json({ ok: true, mensaje: 'Lead eliminado' });
});

// DELETE /api/leads/fecha/:fecha — eliminar todos de una fecha
router.delete('/fecha/:fecha', auth(ROLES_BO), (req, res) => {
  const info = db.prepare(`DELETE FROM leads WHERE fecha = ?`).run(req.params.fecha);
  res.json({ ok: true, eliminados: info.changes });
});

module.exports = router;