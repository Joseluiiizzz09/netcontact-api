/* ================================================
   ROUTES/VENTAS.JS — Guardar y obtener ventas
   ================================================ */
const express = require('express');
const router  = express.Router();
const db      = require('../database');
const auth    = require('../middleware/auth');

const ROLES_VENTAS = ['asesor','supervisor','backoffice','validacion','grabaciones','seguimiento','jefatura','usuarios','programacion'];

// Crear venta
router.post('/', auth(['asesor','backoffice','jefatura','usuarios']), (req, res) => {
  const v = req.body;
  const result = db.prepare(`
    INSERT INTO ventas (
      asesor_id, tipo_doc, dni, nombre, email,
      telefono1, telefono2, departamento, provincia, distrito,
      direccion, coordenadas, fecha_nac, lugar_nac, padre, madre,
      cuota_inst, claro_hogar, tecnologia, paquete,
      full_claro, cant_decos, cant_mesh, plano, estado, observacion
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    req.user.id, v.tipoDoc||'DNI', v.dni, v.nombre, v.email||null,
    v.telefono1||null, v.telefono2||null, v.departamento||null,
    v.provincia||null, v.distrito||null, v.direccion||null,
    v.coordenadas||null, v.fechaNac||null, v.lugarNac||null,
    v.padre||null, v.madre||null,
    v.cuotaInstalacion||null, v.hogar||null, v.tec||null,
    v.paquete||null, v.full||null,
    parseInt(v.cantDecos)||0, parseInt(v.cantMesh)||0,
    v.plano||null, v.estado||'VENTA', v.obs||null
  );
  res.json({ ok: true, id: result.lastInsertRowid, mensaje: 'Venta guardada' });
});

// Obtener ventas
router.get('/', auth(ROLES_VENTAS), (req, res) => {
  const { dni, estado, desde, hasta, asesor_id, programacion } = req.query;
  let sql = `SELECT v.*, u.nombre as asesor_nombre, u.sala FROM ventas v LEFT JOIN usuarios u ON v.asesor_id = u.id WHERE 1=1`;
  const params = [];

  // Asesor solo ve sus propias ventas
  if (req.user.cargo === 'asesor') {
    sql += ` AND v.asesor_id = ?`; params.push(req.user.id);
  } else if (asesor_id) {
    sql += ` AND v.asesor_id = ?`; params.push(asesor_id);
  }

  // Programacion solo ve ventas que ya pasaron grabaciones (estado != VENTA)
  if (req.user.cargo === 'programacion' || programacion === '1') {
    sql += ` AND UPPER(v.estado) != 'VENTA' AND v.estado IS NOT NULL AND v.estado != ''`;
  }

  if (dni)    { sql += ` AND v.dni LIKE ?`;       params.push(`%${dni}%`); }
  if (estado) { sql += ` AND UPPER(v.estado) = ?`; params.push(estado.toUpperCase()); }
  if (desde)  { sql += ` AND date(v.created_at) >= ?`; params.push(desde); }
  if (hasta)  { sql += ` AND date(v.created_at) <= ?`; params.push(hasta); }

  sql += ` ORDER BY v.created_at DESC`;
  const data = db.prepare(sql).all(...params);
  res.json({ ok: true, data });
});

// Actualizar venta
router.patch('/:id', auth(ROLES_VENTAS), (req, res) => {
  const { estado, obs_backoffice, observacion, obs_programacion, obs_validacion, obs_supgrab, estado_supgrab } = req.body;
  const venta = db.prepare(`SELECT id FROM ventas WHERE id = ?`).get(req.params.id);
  if (!venta) return res.status(404).json({ ok: false, mensaje: 'Venta no encontrada' });

  const campos = [];
  const vals   = [];
  if (estado           !== undefined) { campos.push('estado = ?');           vals.push(estado); }
  if (obs_backoffice   !== undefined) { campos.push('obs_backoffice = ?');   vals.push(obs_backoffice); }
  if (observacion      !== undefined) { campos.push('observacion = ?');      vals.push(observacion); }
  if (obs_programacion !== undefined) { campos.push('obs_programacion = ?'); vals.push(obs_programacion); }
  if (obs_validacion   !== undefined) { campos.push('obs_validacion = ?');   vals.push(obs_validacion); }
  if (obs_supgrab     !== undefined) { campos.push('obs_supgrab = ?');     vals.push(obs_supgrab); }
  if (estado_supgrab  !== undefined) { campos.push('estado_supgrab = ?');  vals.push(estado_supgrab); }
  if (!campos.length) return res.status(400).json({ ok: false, mensaje: 'Nada que actualizar' });

  vals.push(req.params.id);
  db.prepare(`UPDATE ventas SET ${campos.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ ok: true, mensaje: 'Venta actualizada' });
});

module.exports = router;