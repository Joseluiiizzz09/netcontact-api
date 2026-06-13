/* ================================================
   ROUTES/FRASES.JS — MySQL
   ================================================ */
const express = require('express');
const router  = express.Router();
const db      = require('../database');
const auth    = require('../middleware/auth');

// POST — publicar frase
router.post('/', auth(['supervisor','jefatura']), async (req, res) => {
  try {
    const { texto, sala } = req.body;
    if (!texto?.trim()) return res.status(400).json({ ok:false, mensaje:'El texto es obligatorio' });
    const [result] = await db.query(
      `INSERT INTO frases (texto, supervisor_id, sala) VALUES (?, ?, ?)`,
      [texto.trim(), req.user.id, sala||null]
    );
    res.json({ ok:true, id: result.insertId, mensaje:'Frase publicada' });
  } catch(e) {
    res.status(500).json({ ok:false, mensaje:'Error al publicar frase' });
  }
});

// GET — frases de hoy
router.get('/', auth(['asesor','supervisor','backoffice','validacion','grabaciones','seguimiento','jefatura']), async (req, res) => {
  try {
    const { sala } = req.query;
    const hoy = new Date().toISOString().split('T')[0];
    let sql = `
      SELECT f.*, u.nombre as supervisor_nombre
      FROM frases f
      LEFT JOIN usuarios u ON f.supervisor_id = u.id
      WHERE DATE(f.created_at) = ?
    `;
    const params = [hoy];
    if (sala) { sql += ` AND (f.sala = ? OR f.sala IS NULL)`; params.push(sala); }
    sql += ` ORDER BY f.created_at DESC`;
    const [data] = await db.query(sql, params);
    res.json({ ok:true, data });
  } catch(e) {
    res.status(500).json({ ok:false, mensaje:'Error al obtener frases' });
  }
});

// DELETE
router.delete('/:id', auth(['supervisor','jefatura']), async (req, res) => {
  try {
    await db.query(`DELETE FROM frases WHERE id = ?`, [req.params.id]);
    res.json({ ok:true, mensaje:'Frase eliminada' });
  } catch(e) {
    res.status(500).json({ ok:false, mensaje:'Error al eliminar frase' });
  }
});

module.exports = router;