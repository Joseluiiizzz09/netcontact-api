/* ================================================
   ROUTES/USUARIOS.JS — CRUD de usuarios
   ================================================ */
const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const db      = require('../database');
const auth    = require('../middleware/auth');

// Agregar columna permisos si no existe
try { db.exec(`ALTER TABLE usuarios ADD COLUMN permisos TEXT DEFAULT '[]'`); } catch(e) {}

const ROLES = ['jefatura','usuarios'];

// Obtener todos
router.get('/', auth(['jefatura','usuarios','backoffice','supervisor']), (req, res) => {
  const lista = db.prepare(`
    SELECT id, nombre, usuario, cargo, sala, genero, activo, permisos, created_at
    FROM usuarios ORDER BY created_at DESC
  `).all();
  res.json({ ok: true, data: lista.map(u => ({
    ...u,
    permisos: (() => { try { return JSON.parse(u.permisos||'[]'); } catch(e){ return []; } })()
  }))});
});

// Crear usuario
router.post('/', auth(ROLES), (req, res) => {
  const { nombre, usuario, password, cargo, sala, genero, activo, permisos } = req.body;
  if (!nombre || !usuario || !password || !cargo)
    return res.status(400).json({ ok: false, mensaje: 'Campos obligatorios faltantes' });

  const existe = db.prepare(`SELECT id FROM usuarios WHERE usuario = ?`).get(usuario.toLowerCase());
  if (existe) return res.status(409).json({ ok: false, mensaje: 'Ese usuario ya existe' });

  const hash = bcrypt.hashSync(password, 10);
  const permisosJSON = JSON.stringify(permisos || []);
  const result = db.prepare(`
    INSERT INTO usuarios (nombre, usuario, password, cargo, sala, genero, activo, permisos)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nombre, usuario.toLowerCase(), hash, cargo, sala||null, genero||'M', activo!==false?1:0, permisosJSON);

  res.json({ ok: true, id: result.lastInsertRowid, mensaje: 'Usuario creado' });
});
  
// Editar usuario
router.patch('/:id', auth(ROLES), (req, res) => {
  const { nombre, usuario, cargo, sala, password, permisos } = req.body;
  const u = db.prepare(`SELECT id FROM usuarios WHERE id = ?`).get(req.params.id);
  if (!u) return res.status(404).json({ ok: false, mensaje: 'Usuario no encontrado' });

  // Verificar usuario único (excluyendo el actual)
  if (usuario) {
    const existe = db.prepare(`SELECT id FROM usuarios WHERE usuario = ? AND id != ?`).get(usuario.toLowerCase(), req.params.id);
    if (existe) return res.status(409).json({ ok: false, mensaje: 'Ese usuario ya existe' });
  }

  const permisosJSON = JSON.stringify(permisos || []);

  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare(`UPDATE usuarios SET nombre=?, usuario=?, cargo=?, sala=?, password=?, permisos=? WHERE id=?`)
      .run(nombre, usuario.toLowerCase(), cargo, sala||null, hash, permisosJSON, req.params.id);
  } else {
    db.prepare(`UPDATE usuarios SET nombre=?, usuario=?, cargo=?, sala=?, permisos=? WHERE id=?`)
      .run(nombre, usuario.toLowerCase(), cargo, sala||null, permisosJSON, req.params.id);
  }
  res.json({ ok: true, mensaje: 'Usuario actualizado' });
});

// Activar / Desactivar
router.patch('/:id/estado', auth(ROLES), (req, res) => {
  const { activo } = req.body;
  db.prepare(`UPDATE usuarios SET activo = ? WHERE id = ?`).run(activo ? 1 : 0, req.params.id);
  res.json({ ok: true, mensaje: activo ? 'Usuario activado' : 'Usuario desactivado' });
});

// Eliminar usuario
router.delete('/:id', auth(ROLES), (req, res) => {
  const u = db.prepare(`SELECT id, usuario FROM usuarios WHERE id = ?`).get(req.params.id);
  if (!u) return res.status(404).json({ ok: false, mensaje: 'Usuario no encontrado' });
  if (u.usuario === 'admin') return res.status(403).json({ ok: false, mensaje: 'No puedes eliminar al administrador' });
  db.prepare(`DELETE FROM usuarios WHERE id = ?`).run(req.params.id);
  res.json({ ok: true, mensaje: 'Usuario eliminado' });
});

module.exports = router;