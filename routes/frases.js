/* ================================================
   ROUTES/FRASES.JS — Frases del supervisor
   ================================================ */
const express = require('express');
const router  = express.Router();
const db      = require('../database');
const auth    = require('../middleware/auth');

// Publicar frase (supervisor)
router.post('/', auth(['supervisor','jefatura']), (req, res) => {
  const { texto, sala } = req.body;
  if (!texto?.trim()) return res.status(400).json({ ok:false, mensaje:'El texto es obligatorio' });

  const result = db.prepare(`
    INSERT INTO frases (texto, supervisor_id, sala)
    VALUES (?, ?, ?)
  `).run(texto.trim(), req.user.id, sala || null);

  res.json({ ok:true, id: result.lastInsertRowid, mensaje:'Frase publicada' });
});

// Obtener frases de hoy
router.get('/', auth(['asesor','supervisor','backoffice','validacion','grabaciones','seguimiento','jefatura']), (req, res) => {
  const { sala } = req.query;
  const hoy = new Date().toISOString().split('T')[0];

  let sql = `
    SELECT f.*, u.nombre as supervisor_nombre
    FROM frases f
    LEFT JOIN usuarios u ON f.supervisor_id = u.id
    WHERE date(f.created_at) = ?
  `;
  const params = [hoy];

  if (sala) {
    sql += ` AND (f.sala = ? OR f.sala IS NULL)`;
    params.push(sala);
  }

  sql += ` ORDER BY f.created_at DESC`;
  const data = db.prepare(sql).all(...params);
  res.json({ ok:true, data });
});

// Eliminar frase (solo el que la creó o jefatura)
router.delete('/:id', auth(['supervisor','jefatura']), (req, res) => {
  db.prepare(`DELETE FROM frases WHERE id = ?`).run(req.params.id);
  res.json({ ok:true, mensaje:'Frase eliminada' });
});

module.exports = router;