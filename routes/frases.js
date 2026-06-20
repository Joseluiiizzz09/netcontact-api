/* ================================================
   ROUTES/FRASES.JS â€” MySQL
   ================================================ */
const express = require('express');
const router  = express.Router();
const db      = require('../database');
const auth    = require('../middleware/auth');

// POST â€” publicar frase
router.post('/', auth(['supervisor','jefatura']), async (req, res) => {
  try {
    const { texto, sala } = req.body;
    if (!texto?.trim()) return res.status(400).json({ ok:false, mensaje:'El texto es obligatorio' });
    if (texto.trim().length > 1000) return res.status(400).json({ ok:false, mensaje:'La frase no puede superar 1000 caracteres' });
    const [result] = await db.query(
      `INSERT INTO frases (texto, supervisor_id, sala) VALUES (?, ?, ?)`,
      [texto.trim(), req.user.id, sala||null]
    );
    res.json({ ok:true, id: result.insertId, mensaje:'Frase publicada' });
  } catch(e) {
    res.status(500).json({ ok:false, mensaje:'Error al publicar frase' });
  }
});

// GET â€” frases de hoy
router.get('/', auth(['asesor','supervisor','backoffice','validacion','grabaciones','seguimiento','jefatura']), async (req, res) => {
  try {
    const { sala } = req.query;
    const ahora=new Date();const peru=new Date(ahora.getTime()+ahora.getTimezoneOffset()*60000+(-5*60*60000));const hoy=peru.getFullYear()+'-'+String(peru.getMonth()+1).padStart(2,'0')+'-'+String(peru.getDate()).padStart(2,'0');
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
    const [rows] = await db.query(`SELECT supervisor_id FROM frases WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok:false, mensaje:'Frase no encontrada' });
    if (req.user.cargo !== 'jefatura' && rows[0].supervisor_id !== req.user.id)
      return res.status(403).json({ ok:false, mensaje:'No puedes eliminar frases de otros supervisores' });
    await db.query(`DELETE FROM frases WHERE id = ?`, [req.params.id]);
    res.json({ ok:true, mensaje:'Frase eliminada' });
  } catch(e) {
    res.status(500).json({ ok:false, mensaje:'Error al eliminar frase' });
  }
});

module.exports = router;
