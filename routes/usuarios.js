/* ================================================
   ROUTES/USUARIOS.JS — MySQL
   ================================================ */
const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const db      = require('../database');
const auth    = require('../middleware/auth');

const ROLES = ['jefatura','usuarios'];
const CARGOS_VALIDOS = ['jefatura','usuarios','supervisor','backoffice','asesor','validacion','grabaciones','seguimiento','programacion','supgrabaciones'];

// GET todos
router.get('/', auth(['jefatura','usuarios','backoffice','supervisor']), async (req, res) => {
  try {
    const [lista] = await db.query(`
      SELECT id, nombre, usuario, cargo, sala, genero, activo, permisos, created_at
      FROM usuarios ORDER BY created_at DESC
    `);
    res.json({ ok: true, data: lista.map(u => ({
      ...u,
      activo: !!u.activo,
      permisos: (() => { try { return JSON.parse(u.permisos||'[]'); } catch(e){ return []; } })()
    }))});
  } catch(e) {
    res.status(500).json({ ok: false, mensaje: 'Error al obtener usuarios' });
  }
});

// POST crear
router.post('/', auth(ROLES), async (req, res) => {
  try {
    const { nombre, usuario, password, cargo, sala, genero, activo, permisos } = req.body;
    if (!nombre || !usuario || !password || !cargo)
      return res.status(400).json({ ok: false, mensaje: 'Campos obligatorios faltantes' });

    if (!CARGOS_VALIDOS.includes(cargo))
      return res.status(400).json({ ok: false, mensaje: 'Cargo inválido' });

    // Solo jefatura puede crear usuarios con cargo elevado
    if (cargo === 'jefatura' && req.user.cargo !== 'jefatura')
      return res.status(403).json({ ok: false, mensaje: 'Solo jefatura puede crear administradores' });

    const [existe] = await db.query(`SELECT id FROM usuarios WHERE usuario = ?`, [usuario.toLowerCase()]);
    if (existe.length) return res.status(409).json({ ok: false, mensaje: 'Ese usuario ya existe' });

    const hash = bcrypt.hashSync(password, 10);
    const permisosJSON = JSON.stringify(permisos || []);
    const [result] = await db.query(`
      INSERT INTO usuarios (nombre, usuario, password, cargo, sala, genero, activo, permisos)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [nombre, usuario.toLowerCase(), hash, cargo, sala||null, genero||'M', activo!==false?1:0, permisosJSON]);

    res.json({ ok: true, id: result.insertId, mensaje: 'Usuario creado' });
  } catch(e) {
    res.status(500).json({ ok: false, mensaje: 'Error al crear usuario' });
  }
});

// PATCH editar
router.patch('/:id', auth(ROLES), async (req, res) => {
  try {
    const { nombre, usuario, cargo, sala, password, permisos } = req.body;
    const [rows] = await db.query(`SELECT id, cargo FROM usuarios WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Usuario no encontrado' });

    // Solo jefatura puede cambiar el cargo o los permisos de un usuario
    if ((cargo !== undefined && cargo !== rows[0].cargo) || permisos !== undefined) {
      if (req.user.cargo !== 'jefatura') {
        return res.status(403).json({ ok: false, mensaje: 'Solo jefatura puede cambiar el cargo o permisos' });
      }
    }

    if (usuario) {
      const [existe] = await db.query(`SELECT id FROM usuarios WHERE usuario = ? AND id != ?`, [usuario.toLowerCase(), req.params.id]);
      if (existe.length) return res.status(409).json({ ok: false, mensaje: 'Ese usuario ya existe' });
    }

    const cargofinal    = req.user.cargo === 'jefatura' ? (cargo || rows[0].cargo) : rows[0].cargo;
    const permisosJSON  = req.user.cargo === 'jefatura' ? JSON.stringify(permisos || []) : undefined;

    if (password) {
      const hash = bcrypt.hashSync(password, 10);
      if (permisosJSON !== undefined) {
        await db.query(`UPDATE usuarios SET nombre=?, usuario=?, cargo=?, sala=?, password=?, permisos=? WHERE id=?`,
          [nombre, usuario.toLowerCase(), cargofinal, sala||null, hash, permisosJSON, req.params.id]);
      } else {
        await db.query(`UPDATE usuarios SET nombre=?, usuario=?, cargo=?, sala=?, password=? WHERE id=?`,
          [nombre, usuario.toLowerCase(), cargofinal, sala||null, hash, req.params.id]);
      }
    } else {
      if (permisosJSON !== undefined) {
        await db.query(`UPDATE usuarios SET nombre=?, usuario=?, cargo=?, sala=?, permisos=? WHERE id=?`,
          [nombre, usuario.toLowerCase(), cargofinal, sala||null, permisosJSON, req.params.id]);
      } else {
        await db.query(`UPDATE usuarios SET nombre=?, usuario=?, cargo=?, sala=? WHERE id=?`,
          [nombre, usuario.toLowerCase(), cargofinal, sala||null, req.params.id]);
      }
    }
    res.json({ ok: true, mensaje: 'Usuario actualizado' });
  } catch(e) {
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar usuario' });
  }
});

// PATCH activar/desactivar
router.patch('/:id/estado', auth(ROLES), async (req, res) => {
  try {
    const { activo } = req.body;
    const [target] = await db.query(`SELECT cargo FROM usuarios WHERE id = ?`, [req.params.id]);
    if (!target.length) return res.status(404).json({ ok: false, mensaje: 'Usuario no encontrado' });
    if (req.user.cargo !== 'jefatura' && target[0].cargo === 'jefatura')
      return res.status(403).json({ ok: false, mensaje: 'Solo jefatura puede activar/desactivar cuentas de jefatura' });
    await db.query(`UPDATE usuarios SET activo = ? WHERE id = ?`, [activo ? 1 : 0, req.params.id]);
    res.json({ ok: true, mensaje: activo ? 'Usuario activado' : 'Usuario desactivado' });
  } catch(e) {
    res.status(500).json({ ok: false, mensaje: 'Error al cambiar estado' });
  }
});

// DELETE
router.delete('/:id', auth(ROLES), async (req, res) => {
  try {
    const [rows] = await db.query(`SELECT id, usuario FROM usuarios WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Usuario no encontrado' });
    if (rows[0].usuario === 'admin') return res.status(403).json({ ok: false, mensaje: 'No puedes eliminar al administrador' });
    await db.query(`DELETE FROM usuarios WHERE id = ?`, [req.params.id]);
    res.json({ ok: true, mensaje: 'Usuario eliminado' });
  } catch(e) {
    res.status(500).json({ ok: false, mensaje: 'Error al eliminar usuario' });
  }
});

module.exports = router;