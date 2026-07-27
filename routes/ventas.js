const express  = require('express');
const router   = express.Router();
const db       = require('../database');
const auth     = require('../middleware/auth');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { validar, errorTexto, errorEmail, errorDni, errorFecha, errorEnteroPositivo, errorId, errorEnum, TIPO_DOC_OK } = require('../middleware/validar');

const ROLES_VENTAS       = ['asesor','supervisor','backoffice','validacion','grabaciones','seguimiento','jefatura','usuarios','programacion','supgrabaciones'];
const ESTADOS_GRAB_OK    = ['pendiente','grabando','grabado','observado','revisado','corta_llamada','suplantacion','no_desea','no_contesta','buzon','buzon_voz'];
const ESTADOS_SUPGRAB_OK = ['sin_revisar','aprobado','rechazado','observado'];
const TRAMOS_SEGUIMIENTO_OK = ['AM 1','AM 2','PM 1','PM 2','PM 3'];
const ESTADOS_VALIDOS_POST  = ['VENTA'];
const ESTADOS_VALIDOS_PATCH = [
  'VENTA','GRABADO','APROBADO','VALIDADO','EN_EJECUCION',
  'INSTALADO','CAIDA','RECHAZO_CAMPO','TECNICO_CASA',
  'PROGRAMADO','PENDIENTE','BLOQUEADO','SIN_AGENDA',
  'CARACTER_ESPECIAL','FRAUDE','ZONA_RESTRINGIDA',
  'ANULADA','OBSERVADA','REPROGRAMADA','NO CONTACTO','RECHAZADA',
  'NO_DESEA','NO_CONTESTA','SERVICIO_ACTIVO','BUZON_VOZ','CORTA_LLAMADA',
];
const ESTADOS_PROGRAMACION = [
  'APROBADO','PROGRAMADO','BLOQUEADO','SIN_AGENDA','CARACTER_ESPECIAL',
  'FRAUDE','ZONA_RESTRINGIDA','INSTALADO','PENDIENTE','CAIDA',
];

// ===== MULTER AUDIO =====
const audioDir = path.join(__dirname, '..', 'uploads', 'audios');
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, audioDir),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, 'venta_' + req.params.id + '_' + Date.now() + ext);
  },
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const extOk = ['.mp3','.wav','.ogg','.m4a','.mp4','.webm'].includes(path.extname(file.originalname).toLowerCase());
    if (extOk) cb(null, true);
    else cb(new Error('Solo archivos de audio'));
  },
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ===== MULTER FOTOS =====
const fotosDir = path.join(__dirname, '..', 'uploads', 'fotos');
if (!fs.existsSync(fotosDir)) fs.mkdirSync(fotosDir, { recursive: true });

const storageFotos = multer.diskStorage({
  destination: (req, file, cb) => cb(null, fotosDir),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
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

// Verifica los primeros bytes del archivo para confirmar que realmente es audio
function esArchivoAudioValido(filePath) {
  try {
    const buffer = Buffer.alloc(12);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, 12, 0);
    fs.closeSync(fd);

    if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return true; // MP3 con ID3
    if (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0)               return true; // MP3 sync
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return true; // WAV RIFF
    if (buffer[0] === 0x4F && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) return true; // OGG
    if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) return true; // WebM
    if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) return true; // MP4/M4A ftyp
    return false;
  } catch(e) {
    return false;
  }
}

// ===== POST /api/ventas =====
router.post('/', auth(['asesor','backoffice','jefatura','usuarios']), async (req, res) => {
  try {
    const v = req.body;

    const errores = validar([
      errorTexto(v.nombre,  'nombre',  { requerido: true, max: 150 }),
      errorTexto(v.dni,     'dni',     { requerido: true }),
      errorDni(v.dni, v.tipoDoc || 'DNI'),
      errorEmail(v.email),
      errorEnum(v.tipoDoc, 'tipoDoc', TIPO_DOC_OK),
      errorTexto(v.telefono1, 'telefono1', { max: 20 }),
      errorTexto(v.telefono2, 'telefono2', { max: 20 }),
      errorFecha(v.fechaNac, 'fechaNac'),
      errorEnteroPositivo(v.cantDecos, 'cantDecos', { max: 10 }),
      errorEnteroPositivo(v.cantMesh,  'cantMesh',  { max: 10 }),
    ]);
    if (errores) return res.status(400).json({ ok: false, mensaje: errores[0], errores });

    const estadoFinal = (v.estado || 'VENTA').toUpperCase();
    if (!ESTADOS_VALIDOS_POST.includes(estadoFinal))
      return res.status(400).json({ ok: false, mensaje: `Estado inválido al crear. Solo se permite: ${ESTADOS_VALIDOS_POST.join(', ')}` });

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
      v.plano||null, estadoFinal, v.obs||null
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

    const errores = validar([
      errorFecha(desde, 'desde'),
      errorFecha(hasta, 'hasta'),
      asesor_id ? errorId(asesor_id, 'asesor_id') : null,
    ]);
    if (errores) return res.status(400).json({ ok: false, mensaje: errores[0] });

    let sql = `SELECT v.*, u.nombre as asesor_nombre, u.sala, g.nombre as grabando_por_nombre
               FROM ventas v
               LEFT JOIN usuarios u ON v.asesor_id = u.id
               LEFT JOIN usuarios g ON v.grabando_por_id = g.id
               WHERE 1=1`;
    const params = [];

    if (req.user.cargo === 'asesor') {
      sql += ` AND v.asesor_id = ?`; params.push(req.user.id);
    } else if (asesor_id) {
      sql += ` AND v.asesor_id = ?`; params.push(asesor_id);
    }

    if (req.user.cargo === 'programacion' || programacion === '1') {
      sql += ` AND UPPER(v.estado) IN (${ESTADOS_PROGRAMACION.map(() => '?').join(',')})`;
      params.push(...ESTADOS_PROGRAMACION);
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
    const [rows] = await db.query(`SELECT id, asesor_id FROM ventas WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Venta no encontrada' });
    if (!req.file)    return res.status(400).json({ ok: false, mensaje: 'No se recibio archivo' });

    // Asesor solo puede subir audio de sus propias ventas
    if (req.user.cargo === 'asesor' && rows[0].asesor_id !== req.user.id) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ ok: false, mensaje: 'No puedes subir audio de ventas de otros asesores' });
    }

    // Verificar bytes reales del archivo
    if (!esArchivoAudioValido(req.file.path)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ ok: false, mensaje: 'El archivo no es un audio válido' });
    }

    const rutaRelativa = 'uploads/audios/' + req.file.filename;
    await db.query(`UPDATE ventas SET audio_path = ? WHERE id = ?`, [rutaRelativa, req.params.id]);
    res.json({ ok: true, ruta: rutaRelativa, mensaje: 'Audio guardado' });
  } catch(e) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
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
      estado_grab,
      obs_seguimiento, tramo_seguimiento, motivo_seguimiento,
      // audio_path no se acepta aquí — solo se actualiza vía POST /:id/audio
    } = req.body;

    const [rows] = await db.query(`SELECT id, asesor_id FROM ventas WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Venta no encontrada' });

    // Asesor solo puede modificar sus propias ventas
    if (req.user.cargo === 'asesor' && rows[0].asesor_id !== req.user.id) {
      return res.status(403).json({ ok: false, mensaje: 'No puedes modificar ventas de otros asesores' });
    }

    // Asesor no puede cambiar el estado — eso corresponde a validacion, programacion, etc.
    if (req.user.cargo === 'asesor' && estado !== undefined) {
      return res.status(403).json({ ok: false, mensaje: 'No tienes permiso para cambiar el estado de una venta' });
    }

    if (estado !== undefined && !ESTADOS_VALIDOS_PATCH.includes(estado.toUpperCase()))
      return res.status(400).json({ ok: false, mensaje: 'Estado inválido.' });

    if (estado_grab !== undefined && !ESTADOS_GRAB_OK.includes(String(estado_grab).toLowerCase()))
      return res.status(400).json({ ok: false, mensaje: 'estado_grab inválido' });
    if (estado_supgrab !== undefined && !ESTADOS_SUPGRAB_OK.includes(String(estado_supgrab).toLowerCase()))
      return res.status(400).json({ ok: false, mensaje: 'estado_supgrab inválido' });

    if (tramo_seguimiento !== undefined && tramo_seguimiento !== '' && !TRAMOS_SEGUIMIENTO_OK.includes(tramo_seguimiento))
      return res.status(400).json({ ok: false, mensaje: 'tramo_seguimiento inválido' });

    const errObs = validar([
      errorTexto(obs_backoffice,   'obs_backoffice',   { max: 1000 }),
      errorTexto(observacion,      'observacion',      { max: 1000 }),
      errorTexto(obs_programacion, 'obs_programacion', { max: 1000 }),
      errorTexto(obs_validacion,   'obs_validacion',   { max: 1000 }),
      errorTexto(obs_supgrab,      'obs_supgrab',      { max: 1000 }),
      errorTexto(obs_seguimiento,    'obs_seguimiento',    { max: 1000 }),
      errorTexto(motivo_seguimiento, 'motivo_seguimiento', { max: 150 }),
    ]);
    if (errObs) return res.status(400).json({ ok: false, mensaje: errObs[0] });

    const campos = [], vals = [];
    if (estado           !== undefined) { campos.push('estado = ?');           vals.push(estado.toUpperCase()); }
    if (obs_backoffice   !== undefined) { campos.push('obs_backoffice = ?');   vals.push(obs_backoffice); }
    if (observacion      !== undefined) { campos.push('observacion = ?');      vals.push(observacion); }
    if (obs_programacion !== undefined) { campos.push('obs_programacion = ?'); vals.push(obs_programacion); }
    if (obs_validacion   !== undefined) { campos.push('obs_validacion = ?');   vals.push(obs_validacion); }
    if (obs_supgrab      !== undefined) { campos.push('obs_supgrab = ?');      vals.push(obs_supgrab); }
    if (estado_supgrab   !== undefined) { campos.push('estado_supgrab = ?');   vals.push(estado_supgrab); }
    if (estado_grab      !== undefined) { campos.push('estado_grab = ?');      vals.push(estado_grab); }
    if (obs_seguimiento    !== undefined) { campos.push('obs_seguimiento = ?');    vals.push(obs_seguimiento); }
    if (tramo_seguimiento  !== undefined) { campos.push('tramo_seguimiento = ?');  vals.push(tramo_seguimiento); }
    if (motivo_seguimiento !== undefined) { campos.push('motivo_seguimiento = ?'); vals.push(motivo_seguimiento); }

    // Responsable de "GRABANDO": SIEMPRE server-side desde el usuario
    // autenticado del token. grabando_por_id NUNCA se lee de req.body — el
    // frontend no puede enviarlo, y aunque lo enviara, arriba no se
    // desestructura, así que se ignora.
    // COALESCE = atómico: solo se fija la primera vez (columna en NULL).
    // La devolución de Super de Grabaciones (observado) envía SIEMPRE
    // estado_grab:'grabando' junto con estado_supgrab:'observado' en el
    // mismo PATCH (ver SupGrabaciones.jsx guardarRevision) — se detecta por
    // esa combinación, no por el cargo del usuario (un cargo con permiso
    // delegado de supgrabaciones podría no coincidir con el check de rol).
    // Así, en el caso borde de una venta histórica sin responsable
    // registrado, jamás queda atribuida a quien la está revisando.
    const esDevolucionSuper = estado_supgrab !== undefined && String(estado_supgrab).toLowerCase() === 'observado';
    if (estado_grab !== undefined && String(estado_grab).toLowerCase() === 'grabando' && !esDevolucionSuper) {
      campos.push('grabando_por_id = COALESCE(grabando_por_id, ?)'); vals.push(req.user.id);
    }

    if (!campos.length) return res.status(400).json({ ok: false, mensaje: 'Nada que actualizar' });

    vals.push(req.params.id);
    await db.query(`UPDATE ventas SET ${campos.join(', ')} WHERE id = ?`, vals);
    res.json({ ok: true, mensaje: 'Venta actualizada' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar venta' });
  }
});

// Parsea líneas de historial con formato "[dd/mm/yyyy, hh:mm - usuario] texto"
// (mismo formato que ya generan Validacion.jsx y SupGrabaciones.jsx al hacer
// append de cada tipificación). Devuelve fecha en "YYYY-MM-DD HH:MM:00" para
// que el frontend (textoFecha en VentaAssignmentModal.jsx) la formatee igual
// que un DATETIME real de MySQL. Líneas que no calcen con el formato se
// ignoran — no se les inventa fecha.
const RE_LINEA_HISTORIAL = /^\[(\d{2})\/(\d{2})\/(\d{4}),?\s+(\d{2}):(\d{2})\s*-\s*(.+?)\]\s*(.*)$/;
function parsearLineasHistorial(texto, modulo) {
  const eventos = [];
  for (const linea of String(texto || '').split('\n')) {
    const m = linea.trim().match(RE_LINEA_HISTORIAL);
    if (!m) continue;
    const [, dd, mm, yyyy, hh, min, usuario, mensaje] = m;
    if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31 || Number(hh) > 23 || Number(min) > 59) continue;
    eventos.push({
      id: `${modulo}-${yyyy}${mm}${dd}${hh}${min}-${eventos.length}`,
      tipo: 'actualizacion',
      modulo,
      usuario_cargo: modulo === 'Validación' ? 'validacion' : 'supgrabaciones',
      usuario_nombre: usuario.trim(),
      usuario_sala: null,
      created_at: `${yyyy}-${mm}-${dd} ${hh}:${min}:00`,
      etiqueta: mensaje.trim() || 'Actualización',
      valor_anterior: null,
      valor_nuevo: null,
      descripcion: null,
    });
  }
  return eventos;
}

// ===== GET /api/ventas/:id/historial =====
// Auditoría consolidada de la venta con datos REALMENTE persistidos:
// creación + historial real de Validación (obs_validacion) + historial real
// de Super Grabaciones (obs_supgrab). Grabaciones/Programación/Seguimiento
// y reasignaciones NO tienen historial persistido todavía (solo guardan el
// último valor) — no se inventan fechas para ellos, ver CLAUDE.md/tarea.
router.get('/:id/historial', auth(['jefatura', 'supervisor']), async (req, res) => {
  try {
    const errId = errorId(req.params.id, 'id');
    if (errId) return res.status(400).json({ ok: false, mensaje: errId });

    const [rows] = await db.query(`
      SELECT v.id, v.nombre, v.created_at, v.obs_validacion, v.obs_supgrab,
             v.asesor_id, u.sala AS asesor_sala, u.nombre AS asesor_nombre
      FROM ventas v
      LEFT JOIN usuarios u ON v.asesor_id = u.id
      WHERE v.id = ?
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Venta no encontrada' });
    const v = rows[0];

    // Jefatura (cargo principal o delegado vía permisos) ve todo. Cualquier
    // otro cargo que llegue aquí solo puede hacerlo como 'supervisor'
    // (único otro permitido en auth() de esta ruta) y se restringe a su
    // propia sala — denegado por defecto si la venta no tiene sala conocida.
    const esJefatura = req.user.cargo === 'jefatura' || (req.user.permisos || []).includes('jefatura');
    if (!esJefatura && v.asesor_sala !== req.user.sala) {
      return res.status(403).json({ ok: false, mensaje: 'No puedes ver el historial de ventas de otra sala' });
    }

    const eventos = [
      {
        id: `creacion-${v.id}`,
        tipo: 'creacion',
        modulo: 'Creación',
        usuario_cargo: 'sistema',
        usuario_nombre: 'No registrado',
        usuario_sala: null,
        created_at: v.created_at,
        etiqueta: 'Venta creada',
        valor_anterior: null,
        valor_nuevo: null,
        descripcion: `Asesor actualmente asignado: ${v.asesor_nombre || 'Sin asignar'}. El asesor original no quedó registrado si la venta fue reasignada.`,
      },
      ...parsearLineasHistorial(v.obs_validacion, 'Validación'),
      ...parsearLineasHistorial(v.obs_supgrab, 'Super Grabaciones'),
    ].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

    res.json({ ok: true, data: eventos });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener historial' });
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
    const [rows] = await db.query(`SELECT id, asesor_id FROM ventas WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Venta no encontrada' });
    if (!req.file)    return res.status(400).json({ ok: false, mensaje: 'No se recibió archivo' });

    // Asesor solo puede subir fotos de sus propias ventas
    if (req.user.cargo === 'asesor' && rows[0].asesor_id !== req.user.id) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ ok: false, mensaje: 'No puedes subir fotos de ventas de otros asesores' });
    }

    const ruta = 'uploads/fotos/' + req.file.filename;
    // Guardamos el nombre original saneado (sin rutas)
    const nombreSeguro = path.basename(req.file.originalname);
    await db.query(`INSERT INTO venta_fotos (venta_id, nombre, ruta, mimetype) VALUES (?,?,?,?)`,
      [req.params.id, nombreSeguro, ruta, req.file.mimetype]);
    res.json({ ok: true, ruta, nombre: nombreSeguro, mensaje: 'Foto guardada' });
  } catch(e) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
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
    const [rows] = await db.query(`SELECT id, asesor_id FROM ventas WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Venta no encontrada' });

    // Asesor solo puede eliminar sus propias ventas
    if (req.user.cargo === 'asesor' && rows[0].asesor_id !== req.user.id) {
      return res.status(403).json({ ok: false, mensaje: 'No puedes eliminar ventas de otros asesores' });
    }

    await db.query(`DELETE FROM ventas WHERE id = ?`, [req.params.id]);
    res.json({ ok: true, mensaje: 'Venta eliminada' });
  } catch(e) {
    res.status(500).json({ ok: false, mensaje: 'Error al eliminar venta' });
  }
});

module.exports = router;
