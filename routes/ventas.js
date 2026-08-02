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
const ESTADOS_SUPGRAB_OK = ['sin_revisar','aprobado','rechazado','observado','programado','conforme','no_conforme'];
const TRAMOS_SEGUIMIENTO_OK = ['AM 1','AM 2','PM 1','PM 2','PM 3'];
const ESTADOS_VALIDOS_POST  = ['VENTA'];
const ESTADOS_VALIDOS_PATCH = [
  'VENTA','GRABADO','APROBADO','VALIDADO','EN_EJECUCION',
  'INSTALADO','CAIDA','RECHAZO_CAMPO','TECNICO_CASA',
  'PROGRAMADO','PENDIENTE','BLOQUEADO','SIN_AGENDA',
  'CARACTER_ESPECIAL','FRAUDE','ZONA_RESTRINGIDA',
  'ANULADA','OBSERVADA','REPROGRAMADA','NO CONTACTO','RECHAZADA','RECHAZADO',
  'NO_DESEA','NO_CONTESTA','SERVICIO_ACTIVO','BUZON_VOZ','CORTA_LLAMADA',
];
const ESTADOS_PROGRAMACION = [
  'APROBADO','PROGRAMADO','BLOQUEADO','SIN_AGENDA','CARACTER_ESPECIAL',
  'FRAUDE','ZONA_RESTRINGIDA','INSTALADO','PENDIENTE','CAIDA',
];

function fechaPeruHoy() {
  const ahora = new Date();
  const peru  = new Date(ahora.getTime() + ahora.getTimezoneOffset() * 60000 + (-5 * 60 * 60000));
  return peru.getFullYear() + '-' + String(peru.getMonth() + 1).padStart(2, '0') + '-' + String(peru.getDate()).padStart(2, '0');
}

async function esTelefonoVentaCerradaHoy(db, asessorId, telefono) {
  const hoy = fechaPeruHoy();
  const [rows] = await db.query(
    `SELECT id, fecha, historial FROM leads WHERE asesor_id = ? AND UPPER(tipif_vend) = 'VENTA CERRADA' AND n1 = ?`,
    [asessorId, String(telefono)]
  );
  for (const l of rows) {
    try {
      const hist = JSON.parse(l.historial || '[]');
      const asignaciones = hist.filter(h => h?.fecha && h?.asesor);
      const ultima = asignaciones[asignaciones.length - 1];
      const fechaEntry = ultima?.fecha
        ? String(ultima.fecha).match(/^(\d{4}-\d{2}-\d{2})/)?.[1]
        : String(l.fecha || '').match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
      if (fechaEntry === hoy) return true;
    } catch(e) { /* skip */ }
  }
  return false;
}

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

function salaNormalizada(sala) {
  return String(sala || '').trim().toUpperCase();
}

async function obtenerActor(conn, userId) {
  const [rows] = await conn.query(
    `SELECT id, nombre, cargo, sala, activo FROM usuarios WHERE id = ? LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function obtenerVentaConAsesor(conn, ventaId, bloquear = false) {
  const [rows] = await conn.query(`
    SELECT v.*,
           u.nombre AS asesor_actual_nombre, u.sala AS asesor_actual_sala
      FROM ventas v
      LEFT JOIN usuarios u ON u.id = v.asesor_id
     WHERE v.id = ?
     ${bloquear ? 'FOR UPDATE' : ''}
  `, [ventaId]);
  return rows[0] || null;
}

function supervisorPuedeGestionar(actor, venta) {
  return salaNormalizada(actor?.sala) !== '' &&
    salaNormalizada(actor?.sala) === salaNormalizada(venta?.asesor_actual_sala);
}

const MODULOS_POR_CARGO = {
  asesor: 'Asesor',
  supervisor: 'Supervisor',
  backoffice: 'Back Data',
  validacion: 'Validación',
  grabaciones: 'Grabaciones',
  supgrabaciones: 'Supervisión de grabaciones',
  programacion: 'Programación',
  seguimiento: 'Seguimiento',
  jefatura: 'Jefatura',
  usuarios: 'Gestión de usuarios',
};

const CAMPOS_HISTORIAL = {
  estado: 'Estado de la venta',
  obs_backoffice: 'Observación de Back Data',
  observacion: 'Observación general',
  obs_programacion: 'Observación de Programación',
  sot: 'SOT',
  fecha_programada: 'Fecha programada',
  obs_validacion: 'Observación de Validación',
  obs_supgrab: 'Observación de Supervisión de grabaciones',
  estado_supgrab: 'Revisión de la grabación',
  estado_grab: 'Estado de grabación',
  obs_seguimiento: 'Observación de Seguimiento',
  tramo_seguimiento: 'Tramo de Seguimiento',
  motivo_seguimiento: 'Motivo de Seguimiento',
  audio_path: 'Archivo de audio',
};

function valorHistorial(valor) {
  if (valor === undefined || valor === null || valor === '') return '—';
  return String(valor);
}

async function registrarHistorial(conn, ventaId, actor, evento = {}) {
  if (!actor) throw new Error('No se pudo identificar al usuario que realizó el cambio.');
  await conn.query(`
    INSERT INTO venta_historial (
      venta_id, tipo, modulo, campo, etiqueta,
      valor_anterior, valor_nuevo, descripcion,
      usuario_id, usuario_nombre, usuario_cargo, usuario_sala
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `, [
    ventaId,
    evento.tipo || 'ACTUALIZACION',
    evento.modulo || MODULOS_POR_CARGO[actor.cargo] || actor.cargo || 'Sistema',
    evento.campo || null,
    evento.etiqueta || (evento.campo ? CAMPOS_HISTORIAL[evento.campo] : null),
    evento.valorAnterior === undefined ? null : valorHistorial(evento.valorAnterior),
    evento.valorNuevo === undefined ? null : valorHistorial(evento.valorNuevo),
    evento.descripcion || null,
    actor.id || null,
    actor.nombre || actor.usuario || 'Usuario',
    actor.cargo || 'sistema',
    actor.sala || null,
  ]);
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

    if (v.telefono1 && !/^\d+$/.test(String(v.telefono1)))
      return res.status(400).json({ ok: false, mensaje: 'El teléfono de contacto solo puede contener números.' });
    if (v.telefono2 && !/^\d+$/.test(String(v.telefono2)))
      return res.status(400).json({ ok: false, mensaje: 'El teléfono de referencia solo puede contener números.' });

    if (req.user.cargo === 'asesor') {
      if (!v.telefono1) return res.status(400).json({ ok: false, mensaje: 'El Teléfono Contacto es obligatorio.' });
      const valido = await esTelefonoVentaCerradaHoy(db, req.user.id, v.telefono1);
      if (!valido) return res.status(400).json({ ok: false, mensaje: 'El teléfono de contacto no corresponde a una VENTA CERRADA del día para este asesor.' });
      const [yaUsado] = await db.query(
        `SELECT id FROM ventas WHERE TRIM(COALESCE(telefono1,'')) = ? LIMIT 1`,
        [String(v.telefono1).trim()]
      );
      if (yaUsado.length > 0)
        return res.status(400).json({ ok: false, mensaje: 'Este número ya fue registrado en otra venta. No puede ser usado nuevamente.' });
    }

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

    // Vencimiento operativo: si Super de Grabaciones no responde en dos
    // horas, vuelve automáticamente a la cola de los asesores de Grabaciones.
    await db.query(`
      UPDATE ventas
         SET estado = 'VALIDADO',
             estado_grab = 'pendiente',
             estado_supgrab = 'no_conforme',
             programacion_expira_at = NULL
       WHERE UPPER(estado) = 'PROGRAMADO'
         AND LOWER(COALESCE(estado_supgrab, '')) = 'programado'
         AND programacion_expira_at IS NOT NULL
         AND programacion_expira_at <= NOW()
    `);

    // fecha_programado: momento real (venta_historial) en que Programación
    // puso estado=PROGRAMADO — no la hora del servidor. Agregado en una sola
    // subconsulta agrupada (no una consulta por fila) para que Super de
    // Grabaciones pueda mostrar "PROGRAMADO: HH:mm / DD/MM/YYYY" cuando el
    // audio todavía no está subido.
    let sql = `SELECT v.*, u.nombre as asesor_nombre, u.sala, g.nombre as grabando_por_nombre,
               ph.fecha_programado
               FROM ventas v
               LEFT JOIN usuarios u ON v.asesor_id = u.id
               LEFT JOIN usuarios g ON v.grabando_por_id = g.id
               LEFT JOIN (
                 SELECT venta_id, MAX(created_at) AS fecha_programado
                 FROM venta_historial
                 WHERE campo = 'estado' AND UPPER(valor_nuevo) = 'PROGRAMADO'
                 GROUP BY venta_id
               ) ph ON ph.venta_id = v.id
               WHERE 1=1`;
    const params = [];

    if (req.user.cargo === 'asesor') {
      sql += ` AND v.asesor_id = ?`; params.push(req.user.id);
    } else if (asesor_id) {
      sql += ` AND v.asesor_id = ?`; params.push(asesor_id);
    }

    if (req.user.cargo === 'programacion' || programacion === '1') {
      // Las ventas que siguen en VALIDADO entran a Programación únicamente
      // después de la aprobación explícita de Super de Grabaciones.
      // Sin revisar, observadas o rechazadas no deben ser visibles aquí.
      sql += ` AND (UPPER(v.estado) IN (${ESTADOS_PROGRAMACION.map(() => '?').join(',')})
                OR (UPPER(v.estado) = 'VALIDADO'
                    AND LOWER(v.estado_grab) = 'grabado'
                    AND LOWER(COALESCE(v.estado_supgrab, 'sin_revisar')) = 'aprobado'))`;
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

// ===== PATCH /api/ventas/:id/reasignar =====
router.patch('/:id/reasignar', auth(['supervisor','jefatura']), async (req, res) => {
  const ventaId = Number(req.params.id);
  const asesorNuevoId = Number(req.body?.asesor_id);
  if (!Number.isInteger(ventaId) || ventaId <= 0 || !Number.isInteger(asesorNuevoId) || asesorNuevoId <= 0) {
    return res.status(400).json({ ok: false, mensaje: 'Venta o asesor no válido.' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const actor = await obtenerActor(conn, req.user.id);
    if (!actor || !actor.activo || !['supervisor','jefatura'].includes(actor.cargo)) {
      await conn.rollback();
      return res.status(403).json({ ok: false, mensaje: 'No tienes permiso para reasignar ventas.' });
    }

    const venta = await obtenerVentaConAsesor(conn, ventaId, true);
    if (!venta) {
      await conn.rollback();
      return res.status(404).json({ ok: false, mensaje: 'Venta no encontrada.' });
    }

    const [destinos] = await conn.query(`
      SELECT id, nombre, usuario, sala, activo
        FROM usuarios
       WHERE id = ? AND cargo = 'asesor'
       LIMIT 1
    `, [asesorNuevoId]);
    const destino = destinos[0];
    if (!destino || !destino.activo) {
      await conn.rollback();
      return res.status(400).json({ ok: false, mensaje: 'El asesor seleccionado no existe o está inactivo.' });
    }
    if (Number(venta.asesor_id) === asesorNuevoId) {
      await conn.rollback();
      return res.status(400).json({ ok: false, mensaje: 'La venta ya pertenece a ese asesor.' });
    }

    if (actor.cargo === 'supervisor') {
      if (!supervisorPuedeGestionar(actor, venta)) {
        await conn.rollback();
        return res.status(403).json({ ok: false, mensaje: 'Solo puedes gestionar ventas de tu sala.' });
      }
      if (salaNormalizada(actor.sala) !== salaNormalizada(destino.sala)) {
        await conn.rollback();
        return res.status(403).json({ ok: false, mensaje: 'Solo puedes reasignar a asesores de tu misma sala.' });
      }
    }

    const anteriorNombre = venta.asesor_actual_nombre || venta.asesor_nombre || 'Sin asignar';
    await conn.query(
      `UPDATE ventas SET asesor_id = ?, asesor_nombre = ? WHERE id = ?`,
      [destino.id, destino.nombre, ventaId]
    );
    await conn.query(`
      INSERT INTO venta_asignaciones (
        venta_id, asesor_anterior_id, asesor_anterior_nombre, asesor_anterior_sala,
        asesor_nuevo_id, asesor_nuevo_nombre, asesor_nuevo_sala,
        cambiado_por_id, cambiado_por_nombre, cambiado_por_cargo
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `, [
      ventaId, venta.asesor_id || null, anteriorNombre, venta.asesor_actual_sala || null,
      destino.id, destino.nombre, destino.sala || null,
      actor.id, actor.nombre, actor.cargo,
    ]);
    await conn.commit();
    res.json({
      ok: true,
      mensaje: `Venta reasignada de ${anteriorNombre} a ${destino.nombre}.`,
      data: { asesor_id: destino.id, asesor_nombre: destino.nombre, sala: destino.sala || '' },
    });
  } catch (e) {
    await conn.rollback().catch(() => {});
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al reasignar la venta.' });
  } finally {
    conn.release();
  }
});

router.get('/:id/historial-asignaciones', auth(['jefatura']), async (req, res) => {
  const ventaId = Number(req.params.id);
  if (!Number.isInteger(ventaId) || ventaId <= 0) {
    return res.status(400).json({ ok: false, mensaje: 'Venta no válida.' });
  }
  try {
    const actor = await obtenerActor(db, req.user.id);
    const venta = await obtenerVentaConAsesor(db, ventaId);
    if (!venta) return res.status(404).json({ ok: false, mensaje: 'Venta no encontrada.' });
    if (!actor || !actor.activo || actor.cargo !== 'jefatura') {
      return res.status(403).json({ ok: false, mensaje: 'No tienes permiso para ver este historial.' });
    }
    const [data] = await db.query(`
      SELECT id, venta_id,
             asesor_anterior_id, asesor_anterior_nombre, asesor_anterior_sala,
             asesor_nuevo_id, asesor_nuevo_nombre, asesor_nuevo_sala,
             cambiado_por_id, cambiado_por_nombre, cambiado_por_cargo, created_at
        FROM venta_asignaciones
       WHERE venta_id = ?
       ORDER BY created_at ASC, id ASC
    `, [ventaId]);
    res.json({ ok: true, data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener el historial de asignaciones.' });
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
    const actor = await obtenerActor(db, req.user.id);
    await registrarHistorial(db, req.params.id, actor, {
      tipo: 'ARCHIVO',
      campo: 'audio_path',
      valorAnterior: null,
      valorNuevo: req.file.originalname,
      descripcion: 'Se subió o reemplazó la grabación de audio de la venta.',
    });
    res.json({ ok: true, ruta: rutaRelativa, mensaje: 'Audio guardado' });
  } catch(e) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al guardar audio' });
  }
});

// ===== PATCH /api/ventas/:id =====
router.patch('/:id', auth(ROLES_VENTAS), async (req, res) => {
  const conn = await db.getConnection();
  try {
    const {
      estado, obs_backoffice, observacion,
      obs_programacion, sot, fecha_programada, obs_validacion,
      obs_supgrab, estado_supgrab,
      estado_grab,
      obs_seguimiento, tramo_seguimiento, motivo_seguimiento,
      // audio_path no se acepta aquí — solo se actualiza vía POST /:id/audio
    } = req.body;

    const [rows] = await conn.query(`
      SELECT id, asesor_id, estado, obs_backoffice, observacion,
             obs_programacion, sot, fecha_programada, obs_validacion, obs_supgrab,
             estado_supgrab, estado_grab, obs_seguimiento,
             tramo_seguimiento, motivo_seguimiento
        FROM ventas
       WHERE id = ?
    `, [req.params.id]);
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
      errorTexto(sot,              'sot',              { max: 100 }),
      errorFecha(fecha_programada, 'fecha_programada'),
      errorTexto(obs_validacion,   'obs_validacion',   { max: 1000 }),
      errorTexto(obs_supgrab,      'obs_supgrab',      { max: 1000 }),
      errorTexto(obs_seguimiento,    'obs_seguimiento',    { max: 1000 }),
      errorTexto(motivo_seguimiento, 'motivo_seguimiento', { max: 150 }),
    ]);
    if (errObs) return res.status(400).json({ ok: false, mensaje: errObs[0] });

    const campos = [], vals = [], cambios = [];
    const agregarCambio = (campo, valor) => {
      if (valor === undefined) return;
      const normalizado = campo === 'estado' ? String(valor).toUpperCase() : valor;
      campos.push(`${campo} = ?`);
      vals.push(normalizado);
      if (valorHistorial(rows[0][campo]) !== valorHistorial(normalizado)) {
        cambios.push({ campo, valorAnterior: rows[0][campo], valorNuevo: normalizado });
      }
    };
    agregarCambio('estado', estado);
    agregarCambio('obs_backoffice', obs_backoffice);
    agregarCambio('observacion', observacion);
    agregarCambio('obs_programacion', obs_programacion);
    agregarCambio('sot', sot);
    agregarCambio('fecha_programada', fecha_programada);
    agregarCambio('obs_validacion', obs_validacion);
    agregarCambio('obs_supgrab', obs_supgrab);
    agregarCambio('estado_supgrab', estado_supgrab);
    agregarCambio('estado_grab', estado_grab);
    agregarCambio('obs_seguimiento', obs_seguimiento);
    agregarCambio('tramo_seguimiento', tramo_seguimiento);
    agregarCambio('motivo_seguimiento', motivo_seguimiento);

    if (estado !== undefined && String(estado).toUpperCase() === 'PROGRAMADO') {
      campos.push('programacion_expira_at = DATE_ADD(NOW(), INTERVAL 2 HOUR)');
    } else if (estado !== undefined && String(estado).toUpperCase() === 'PENDIENTE') {
      campos.push('programacion_expira_at = NULL');
    } else if (estado_supgrab !== undefined && ['conforme', 'no_conforme'].includes(String(estado_supgrab).toLowerCase())) {
      campos.push('programacion_expira_at = NULL');
    }

    // Responsable de "GRABANDO": SIEMPRE server-side desde el usuario
    // autenticado del token. grabando_por_id NUNCA se lee de req.body — el
    // frontend no puede enviarlo, y aunque lo enviara, arriba no se
    // desestructura, así que se ignora.
    // Cada usuario de Grabaciones que marque GRABANDO toma la venta. Así,
    // si Brito continúa una venta que antes tenía Iris, todos verán
    // inmediatamente "GRABANDO BRITO" en la cola compartida.
    // La devolución de Super de Grabaciones (observado) envía SIEMPRE
    // estado_grab:'grabando' junto con estado_supgrab:'observado' en el
    // mismo PATCH (ver SupGrabaciones.jsx guardarRevision) — se detecta por
    // esa combinación, no por el cargo del usuario (un cargo con permiso
    // delegado de supgrabaciones podría no coincidir con el check de rol).
    // Así, en el caso borde de una venta histórica sin responsable
    // registrado, jamás queda atribuida a quien la está revisando.
    const esDevolucionSuper = estado_supgrab !== undefined && String(estado_supgrab).toLowerCase() === 'observado';
    if (estado_grab !== undefined && String(estado_grab).toLowerCase() === 'grabando' && !esDevolucionSuper) {
      campos.push('grabando_por_id = ?'); vals.push(req.user.id);
    }

    if (!campos.length) return res.status(400).json({ ok: false, mensaje: 'Nada que actualizar' });

    await conn.beginTransaction();
    vals.push(req.params.id);
    await conn.query(`UPDATE ventas SET ${campos.join(', ')} WHERE id = ?`, vals);
    const actor = await obtenerActor(conn, req.user.id);
    for (const cambio of cambios) {
      await registrarHistorial(conn, req.params.id, actor, cambio);
    }
    await conn.commit();
    res.json({ ok: true, mensaje: 'Venta actualizada' });
  } catch(e) {
    await conn.rollback().catch(() => {});
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar venta' });
  } finally {
    conn.release();
  }
});

// Parsea líneas de historial con formato "[dd/mm/yyyy, hh:mm - usuario] texto"
// (mismo formato que ya generan Validacion.jsx y SupGrabaciones.jsx al hacer
// append de cada tipificación). Devuelve fecha en "YYYY-MM-DD HH:MM:00" para
// que el frontend (textoFecha en VentaAssignmentModal.jsx) la formatee igual
// que un DATETIME real de MySQL. Líneas que no calcen con el formato se
// ignoran — no se les inventa fecha.
router.get('/:id/historial', auth(['jefatura']), async (req, res) => {
  const ventaId = Number(req.params.id);
  if (!Number.isInteger(ventaId) || ventaId <= 0) {
    return res.status(400).json({ ok: false, mensaje: 'Venta no válida.' });
  }
  try {
    const actor = await obtenerActor(db, req.user.id);
    if (!actor || !actor.activo || actor.cargo !== 'jefatura') {
      return res.status(403).json({ ok: false, mensaje: 'El historial completo es exclusivo de Jefatura.' });
    }
    const [ventas] = await db.query(`
      SELECT v.id, v.estado, v.created_at, v.asesor_id,
             COALESCE(u.nombre, v.asesor_nombre) AS asesor_nombre, u.sala AS asesor_sala
        FROM ventas v LEFT JOIN usuarios u ON u.id = v.asesor_id
       WHERE v.id = ? LIMIT 1
    `, [ventaId]);
    const venta = ventas[0];
    if (!venta) return res.status(404).json({ ok: false, mensaje: 'Venta no encontrada.' });
    const [cambios] = await db.query(`
      SELECT id, venta_id, tipo, modulo, campo, etiqueta, valor_anterior, valor_nuevo,
             descripcion, usuario_id, usuario_nombre, usuario_cargo, usuario_sala, created_at
        FROM venta_historial WHERE venta_id = ?
    `, [ventaId]);
    const [asignaciones] = await db.query(`
      SELECT id, asesor_anterior_nombre, asesor_anterior_sala, asesor_nuevo_nombre,
             asesor_nuevo_sala, cambiado_por_id, cambiado_por_nombre,
             cambiado_por_cargo, created_at
        FROM venta_asignaciones WHERE venta_id = ?
    `, [ventaId]);
    const historial = [{
      id: `creacion-${venta.id}`, tipo: 'CREACION', modulo: 'Asesor', campo: 'estado',
      etiqueta: 'Venta registrada', valor_anterior: null, valor_nuevo: venta.estado || 'VENTA',
      descripcion: 'Registro inicial de la venta en el sistema.', usuario_id: venta.asesor_id,
      usuario_nombre: venta.asesor_nombre || 'Usuario original', usuario_cargo: 'asesor',
      usuario_sala: venta.asesor_sala, created_at: venta.created_at,
    }, ...cambios, ...asignaciones.map(item => ({
      id: `asignacion-${item.id}`, tipo: 'REASIGNACION',
      modulo: MODULOS_POR_CARGO[item.cambiado_por_cargo] || item.cambiado_por_cargo || 'Jefatura',
      campo: 'asesor_id', etiqueta: 'Asesor responsable',
      valor_anterior: `${item.asesor_anterior_nombre || 'Sin asignar'} · ${item.asesor_anterior_sala || 'Sin sala'}`,
      valor_nuevo: `${item.asesor_nuevo_nombre || 'Sin asignar'} · ${item.asesor_nuevo_sala || 'Sin sala'}`,
      descripcion: 'La venta fue reasignada a otro asesor.', usuario_id: item.cambiado_por_id,
      usuario_nombre: item.cambiado_por_nombre, usuario_cargo: item.cambiado_por_cargo,
      usuario_sala: null, created_at: item.created_at,
    }))].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) ||
      String(a.id).localeCompare(String(b.id)));
    res.json({ ok: true, data: historial });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener el historial completo de la venta.' });
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
    const actor = await obtenerActor(db, req.user.id);
    await registrarHistorial(db, req.params.id, actor, {
      tipo: 'ARCHIVO',
      campo: 'foto',
      etiqueta: 'Foto o documento',
      valorAnterior: null,
      valorNuevo: nombreSeguro,
      descripcion: 'Se agregó un archivo a la venta.',
    });
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
    const actor = await obtenerActor(db, req.user.id);
    await registrarHistorial(db, req.params.id, actor, {
      tipo: 'ARCHIVO',
      campo: 'foto',
      etiqueta: 'Foto o documento',
      valorAnterior: rows[0].nombre,
      valorNuevo: 'Eliminado',
      descripcion: 'Se eliminó un archivo de la venta.',
    });
    res.json({ ok: true, mensaje: 'Foto eliminada' });
  } catch(e) {
    res.status(500).json({ ok: false, mensaje: 'Error al eliminar foto' });
  }
});

// ===== DELETE /api/ventas/:id =====
router.delete('/:id', auth(['supervisor','jefatura']), async (req, res) => {
  try {
    const actor = await obtenerActor(db, req.user.id);
    const venta = await obtenerVentaConAsesor(db, req.params.id);
    if (!venta) return res.status(404).json({ ok: false, mensaje: 'Venta no encontrada' });
    if (!actor || !actor.activo || !['supervisor','jefatura'].includes(actor.cargo)) {
      return res.status(403).json({ ok: false, mensaje: 'No tienes permiso para eliminar ventas.' });
    }
    if (actor.cargo === 'supervisor' && !supervisorPuedeGestionar(actor, venta)) {
      return res.status(403).json({ ok: false, mensaje: 'Solo puedes eliminar ventas de tu sala.' });
    }

    await db.query(`DELETE FROM ventas WHERE id = ?`, [req.params.id]);
    await db.query(
      `INSERT INTO eliminaciones
        (actor_id, actor_nombre, actor_cargo, tipo, registro_id, detalle, snapshot_json)
       VALUES (?, ?, ?, 'VENTA', ?, ?, ?)`,
      [
        actor.id,
        actor.nombre || 'Usuario',
        actor.cargo || '',
        String(req.params.id),
        `${venta.nombre || 'Sin nombre'} · DNI ${venta.dni || '—'} · Asesor ${venta.asesor_nombre || '—'}`,
        JSON.stringify(venta),
      ]
    );
    res.json({ ok: true, mensaje: 'Venta eliminada' });
  } catch(e) {
    res.status(500).json({ ok: false, mensaje: 'Error al eliminar venta' });
  }
});

module.exports = router;
