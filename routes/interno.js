const express = require('express');
const router  = express.Router();
const db      = require('../database');
const verificarClaveInternaPrizma = require('../middleware/verificarClaveInternaPrizma');

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

// POST /api/interno/lead-prizma
// Crea un lead nuevo (sin tipificar, sin asignar) a partir de un numero
// sincronizado automaticamente desde Prizma. Protegido por X-Internal-Key.
// Body: { n1, campana }
router.post('/lead-prizma', verificarClaveInternaPrizma, async (req, res) => {
  try {
    const n1 = normalizarN1(req.body?.n1);
    if (!n1) return res.status(400).json({ ok: false, mensaje: 'Falta el numero (n1)' });

    const campana  = String(req.body?.campana || 'YOPI').trim() || 'YOPI';
    const fechaHoy = fechaPeruHoy();

    const [existentes] = await db.query(`
      SELECT id FROM leads
      WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(n1,' ',''),'-',''),'(',''),')',''),'+',''),'.','') = ?
        AND fecha = ? AND campana = ?
      LIMIT 1
    `, [n1, fechaHoy, campana]);
    if (existentes.length) {
      return res.json({ ok: true, ya_existia: true, id: existentes[0].id });
    }

    const historial = JSON.stringify([{
      tipo: 'CARGA', cargadoPor: 'Sistema Prizma', hora: horaPeruAhora(),
      fecha: fechaHoy, motivo: 'Sincronizacion automatica desde Prizma (SIN COBERTURA)',
    }]);

    const [result] = await db.query(`
      INSERT INTO leads (campana, n1, fecha, sin_asignar, historial, rotaciones, creado_por_nombre, creado_por_usuario)
      VALUES (?, ?, ?, 1, ?, 0, 'Sistema Prizma', 'sistema-prizma')
    `, [campana, n1, fechaHoy, historial]);

    res.json({ ok: true, id: result.insertId });
  } catch (e) {
    console.error('[interno/lead-prizma] Error:', e);
    res.status(500).json({ ok: false, mensaje: 'Error al crear el lead' });
  }
});

module.exports = router;
