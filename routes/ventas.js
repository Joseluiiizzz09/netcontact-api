/* ================================================
   ROUTES/VENTAS.JS — MySQL
   ================================================ */
const express  = require('express');
const router   = express.Router();
const db       = require('../database');
const auth     = require('../middleware/auth');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');

const ROLES_VENTAS = ['asesor','supervisor','backoffice','validacion','grabaciones','seguimiento','jefatura','usuarios','programacion','supgrabaciones'];

// ===== MULTER AUDIO =====
const audioDir = path.join(__dirname, '..', 'uploads', 'audios');
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, audioDir),
  filename:    (req, file, cb) => {
    const ext  = path.extname(file.originalname);
    cb(null, 'venta_' + req.params.id + '_' + Date.now() + ext);
  },
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/') || ['.mp3','.wav','.ogg','.m4a','.mp4','.webm'].includes(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else cb(new Error('Solo archivos de audio'));
  },
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ===== MULTER FOTOS =====
const fotosDir = path.join(__dirname, '..', 'uploads', 'fotos');
if (!fs.existsSync(fotosDir)) fs.mkdirSync(fotosDir, { recursive: true });

const storageFotos = multer.diskStorage({
  destination: (req, file, cb) => cb(null, fotosDir),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, 'foto_' + req.params.id + '_' + Date.now() + ext);
  },
});
const uploadFoto = multer({
  storage: storageFotos,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Solo imágenes o PDF'));
  },
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ===== POST /api/ventas =====
router.post('/', auth(['asesor','backoffice','jefatura','usuarios']), async (req, res) => {
  try {
    const v = req.body;
    const [result] = await db.query(`
      INSERT INTO ventas (
        asesor_id, tipo_doc, dni, nombre, email,
        telefono1, telefono2, departamento, provincia, distrito,
        direccion, coordenadas, fecha_nac, lugar_nac, padre, madre,
        cuota_inst, claro_hogar, tecnologia, paquete,
        full_claro, cant_decos, cant_mesh, plano, estado, observacion
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      req.user.id, v.tipoDoc||'DNI', v.dni||null, v.nombre||null, v.email||null,
      v.telefono1||null, v.telefono2||null, v.departamento||null,
      v.provincia||null, v.distrito||null, v.direccion||null,
      v.coordenadas||null, v.fechaNac||null, v.lugarNac||null,
      v.padre||null, v.madre||null,
      v.cuotaInstalacion||null, v.hogar||null, v.tec||null,
      v.paquete||null, v.full||null,
      parseInt(v.cantDecos)||0, parseInt(v.cantMesh)||0,
      v.plano||null, v.estado||'VENTA', v.obs||null
    ]);
    res.json({ ok: true, id: result.insertId, mensaje: 'Venta guardada' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al guardar venta' });
  }
});

// ===== GET /api/ventas =====
router.get('/', auth(ROLES_VENTAS), async (req, res) => {
  try {
    const { dni, estado, desde, hasta, asesor_id, programacion } = req.query;
    let sql = `SELECT v.*, u.nombre as asesor_nombre, u.sala FROM ventas v LEFT JOIN usuarios u ON v.asesor_id = u.id WHERE 1=1`;
    const params = [];

    if (req.user.cargo === 'asesor') {
      sql += ` AND v.asesor_id = ?`; params.push(req.user.id);
    } else if (asesor_id) {
      sql += ` AND v.asesor_id = ?`; params.push(asesor_id);
    }

    if (req.user.cargo === 'programacion' || programacion === '1') {
      sql += ` AND UPPER(v.estado) != 'VENTA' AND v.estado IS NOT NULL AND v.estado != ''`;
    }

    if (dni)    { sql += ` AND v.dni LIKE ?`;              params.push(`%${dni}%`); }
    if (estado) { sql += ` AND LOWER(v.estado) = ?`;       params.push(estado.toLowerCase()); }
    if (desde)  { sql += ` AND DATE(v.created_at) >= ?`;   params.push(desde); }
    if (hasta)  { sql += ` AND DATE(v.created_at) <= ?`;   params.push(hasta); }

    sql += ` ORDER BY v.created_at DESC`;
    const [data] = await db.query(sql, params);
    res.json({ ok: true, data });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener ventas' });
  }
});

// ===== POST /api/ventas/:id/audio =====
router.post('/:id/audio', auth(ROLES_VENTAS), upload.single('audio'), async (req, res) => {
  try {
    const [rows] = await db.query(`SELECT id FROM ventas WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Venta no encontrada' });
    if (!req.file)    return res.status(400).json({ ok: false, mensaje: 'No se recibio archivo' });

    const rutaRelativa = 'uploads/audios/' + req.file.filename;
    await db.query(`UPDATE ventas SET audio_path = ? WHERE id = ?`, [rutaRelativa, req.params.id]);
    res.json({ ok: true, ruta: rutaRelativa, mensaje: 'Audio guardado' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al guardar audio' });
  }
});

// ===== PATCH /api/ventas/:id =====
router.patch('/:id', auth(ROLES_VENTAS), async (req, res) => {
  try {
    const {
      estado, obs_backoffice, observacion,
      obs_programacion, obs_validacion,
      obs_supgrab, estado_supgrab,
      estado_grab, audio_path,
    } = req.body;

    const [rows] = await db.query(`SELECT id FROM ventas WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Venta no encontrada' });

    const campos = [], vals = [];
    if (estado           !== undefined) { campos.push('estado = ?');           vals.push(estado); }
    if (obs_backoffice   !== undefined) { campos.push('obs_backoffice = ?');   vals.push(obs_backoffice); }
    if (observacion      !== undefined) { campos.push('observacion = ?');      vals.push(observacion); }
    if (obs_programacion !== undefined) { campos.push('obs_programacion = ?'); vals.push(obs_programacion); }
    if (obs_validacion   !== undefined) { campos.push('obs_validacion = ?');   vals.push(obs_validacion); }
    if (obs_supgrab      !== undefined) { campos.push('obs_supgrab = ?');      vals.push(obs_supgrab); }
    if (estado_supgrab   !== undefined) { campos.push('estado_supgrab = ?');   vals.push(estado_supgrab); }
    if (estado_grab      !== undefined) { campos.push('estado_grab = ?');      vals.push(estado_grab); }
    if (audio_path       !== undefined) { campos.push('audio_path = ?');       vals.push(audio_path); }

    if (!campos.length) return res.status(400).json({ ok: false, mensaje: 'Nada que actualizar' });

    vals.push(req.params.id);
    await db.query(`UPDATE ventas SET ${campos.join(', ')} WHERE id = ?`, vals);
    res.json({ ok: true, mensaje: 'Venta actualizada' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar venta' });
  }
});

// ===== GET /api/ventas/:id/fotos =====
router.get('/:id/fotos', auth(ROLES_VENTAS), async (req, res) => {
  try {
    const [fotos] = await db.query(`SELECT * FROM venta_fotos WHERE venta_id = ? ORDER BY created_at ASC`, [req.params.id]);
    res.json({ ok: true, data: fotos });
  } catch(e) {
    res.status(500).json({ ok: false, mensaje: 'Error al obtener fotos' });
  }
});

// ===== POST /api/ventas/:id/fotos =====
router.post('/:id/fotos', auth(ROLES_VENTAS), uploadFoto.single('foto'), async (req, res) => {
  try {
    const [rows] = await db.query(`SELECT id FROM ventas WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Venta no encontrada' });
    if (!req.file)    return res.status(400).json({ ok: false, mensaje: 'No se recibió archivo' });

    const ruta = 'uploads/fotos/' + req.file.filename;
    await db.query(`INSERT INTO venta_fotos (venta_id, nombre, ruta, mimetype) VALUES (?,?,?,?)`,
      [req.params.id, req.file.originalname, ruta, req.file.mimetype]);
    res.json({ ok: true, ruta, nombre: req.file.originalname, mensaje: 'Foto guardada' });
  } catch(e) {
    res.status(500).json({ ok: false, mensaje: 'Error al guardar foto' });
  }
});

// ===== DELETE /api/ventas/:id/fotos/:fotoId =====
router.delete('/:id/fotos/:fotoId', auth(ROLES_VENTAS), async (req, res) => {
  try {
    const [rows] = await db.query(`SELECT * FROM venta_fotos WHERE id = ? AND venta_id = ?`, [req.params.fotoId, req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Foto no encontrada' });
    try {
      const filePath = path.join(__dirname, '..', rows[0].ruta);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch(e) {}
    await db.query(`DELETE FROM venta_fotos WHERE id = ?`, [req.params.fotoId]);
    res.json({ ok: true, mensaje: 'Foto eliminada' });
  } catch(e) {
    res.status(500).json({ ok: false, mensaje: 'Error al eliminar foto' });
  }
});

// ===== DELETE /api/ventas/:id =====
router.delete('/:id', auth(ROLES_VENTAS), async (req, res) => {
  try {
    const [rows] = await db.query(`SELECT id FROM ventas WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Venta no encontrada' });
    await db.query(`DELETE FROM ventas WHERE id = ?`, [req.params.id]);
    res.json({ ok: true, mensaje: 'Venta eliminada' });
  } catch(e) {
    res.status(500).json({ ok: false, mensaje: 'Error al eliminar venta' });
  }
});

module.exports = router;