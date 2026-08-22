const express  = require('express');
const router   = express.Router();
const db       = require('../database');
const auth     = require('../middleware/auth');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { validar, errorTexto, errorEmail, errorDni, errorFecha, errorEnteroPositivo, errorId, errorEnum, TIPO_DOC_OK } = require('../middleware/validar');

const ROLES_VENTAS       = ['asesor','supervisor','backoffice','validacion','grabaciones','seguimiento','jefatura','usuarios','programacion','cobranzas','calidad','supgrabaciones'];
const CACHE_VENTAS_TTL = 5000;
const cacheVentas = new Map();

function cacheVentasGet(clave) {
  const item = cacheVentas.get(clave);
  if (!item || item.expira <= Date.now()) { cacheVentas.delete(clave); return null; }
  return item.payload;
}

function cacheVentasSet(clave, payload) {
  if (cacheVentas.size >= 200) cacheVentas.delete(cacheVentas.keys().next().value);
  cacheVentas.set(clave, { payload, expira: Date.now() + CACHE_VENTAS_TTL });
}
const ESTADOS_GRAB_OK    = ['pendiente','grabando','grabado','observado','revisado','corta_llamada','suplantacion','no_desea','no_contesta','buzon','buzon_voz','esperando_tercero','corregir_sec'];
const ESTADOS_SUPGRAB_OK = ['sin_revisar','aprobado','rechazado','observado','programado','conforme','no_conforme','audio_subido'];
const TRAMOS_SEGUIMIENTO_OK = ['AM','PM','PM 3'];
const ESTADOS_VALIDOS_POST  = ['VENTA'];
const ESTADOS_VALIDOS_PATCH = [
  'VENTA','GRABADO','APROBADO','VALIDADO','EN_EJECUCION',
  'INSTALADO','CAIDA','RECHAZO_CAMPO','TECNICO_CASA',
  'LEVANTAR_SOT','TECNICOS_CAMINO','INSTALADO_NO_VALIDADO','REASIGNACION','DERIVADO_PLANTA_EXTERNA',
  'PROGRAMADO','PENDIENTE','BLOQUEADO','SIN_AGENDA',
  'CARACTER_ESPECIAL','FRAUDE','ZONA_RESTRINGIDA',
  'ANULADA','OBSERVADA','REPROGRAMADA','NO CONTACTO','RECHAZADA','RECHAZADO',
  'NO_DESEA','NO_CONTESTA','SERVICIO_ACTIVO','BUZON_VOZ','CORTA_LLAMADA',
  'CORREGIR','MALA_OFERTA','RECHAZO_MESA',
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
    const esMp3 = path.extname(file.originalname).toLowerCase() === '.mp3'
      && ['audio/mpeg', 'audio/mp3', 'application/octet-stream'].includes(String(file.mimetype || '').toLowerCase());
    if (esMp3) cb(null, true);
    else cb(new Error('Solo se permite un archivo MP3'));
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

// Verifica los primeros bytes para impedir que otro formato sea renombrado a .mp3.
function esArchivoMp3Valido(filePath) {
  try {
    const buffer = Buffer.alloc(3);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, 3, 0);
    fs.closeSync(fd);
    return (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33)
      || (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0);
  } catch (e) {
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
  nombre: 'Nombre del cliente',
  tipo_doc: 'Tipo de documento',
  dni: 'Número de documento',
  email: 'Correo electrónico',
  telefono1: 'Teléfono principal',
  telefono2: 'Teléfono secundario',
  departamento: 'Departamento',
  provincia: 'Provincia',
  distrito: 'Distrito',
  direccion: 'Dirección',
  coordenadas: 'Coordenadas',
  paquete: 'Paquete',
  cuota_inst: 'Cuota de instalación',
  claro_hogar: 'Claro Hogar',
  tecnologia: 'Tecnología',
  full_claro: 'Full Claro',
  cant_decos: 'Cantidad de decos',
  cant_mesh: 'Cantidad de mesh',
  plano: 'Plano',
  fecha_nac: 'Fecha de nacimiento',
  lugar_nac: 'Lugar de nacimiento',
  padre: 'Nombre del padre',
  madre: 'Nombre de la madre',
};

function valorHistorial(valor) {
  if (valor === undefined || valor === null || valor === '') return '—';
  return String(valor);
}

function normalizarEstadoCRM(valor) {
  return String(valor || '').trim().toUpperCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
}

const ESTADOS_VENTA_CAIDA_SEGUIMIENTO = new Set(['CAIDA','RECHAZO','RECHAZO CAMPO','RECHAZO EN CAMPO','RECHAZO MESA','RECHAZO EN MESA','SERVICIO ACTIVO']);
const ESTADOS_VENTA_CAIDA_VALIDACION = new Set(['CORTA LLAMADA','BUZON DE VOZ','CORREGIR','FRAUDE','MALA OFERTA','NO CONTESTA','NO DESEA','SERVICIO ACTIVO']);
const ESTADOS_VENTA_CAIDA_GRABACION = new Set(['PENDIENTE','BUZON DE VOZ','BUZON','CORREGIR SEC','CORTA LLAMADA','ESPERANDO TERCERO','NO CONTESTA','NO DESEA','SUPLANTACION']);

function ventaEstaCaida(venta) {
  if (!venta) return false;
  const candidatos = [];
  const agregar = (estados, valor, fecha, prioridad) => {
    const estado = normalizarEstadoCRM(valor);
    if (estado) candidatos.push({ caida: estados.has(estado), fecha: fecha || venta.created_at || '', prioridad });
  };
  const general = normalizarEstadoCRM(venta.estado);
  const validacion = venta.estado_validacion || (['VENTA','VALIDADO'].includes(general) ? general : '');
  agregar(ESTADOS_VENTA_CAIDA_VALIDACION, validacion, venta.fecha_validacion, 1);
  agregar(ESTADOS_VENTA_CAIDA_GRABACION, venta.estado_grab, venta.fecha_grabacion, 2);
  agregar(ESTADOS_VENTA_CAIDA_SEGUIMIENTO, venta.estado, venta.fecha_seguimiento, 3);
  candidatos.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || a.prioridad - b.prioridad);
  return candidatos[candidatos.length - 1]?.caida === true;
}

async function completarEstadoVentaCaida(conn, venta) {
  if (!venta?.id) return venta;
  const [eventos] = await conn.query(`
    SELECT tipo, modulo, campo, valor_nuevo, created_at
    FROM venta_historial
    WHERE venta_id = ?
      AND (
        (campo = 'estado' AND tipo = 'CAMBIO_VALIDACION')
        OR campo = 'estado_grab'
        OR (modulo = 'Seguimiento' AND campo IN ('estado','motivo_seguimiento','tramo_seguimiento'))
      )
    ORDER BY id ASC
  `, [venta.id]);
  const completa = { ...venta };
  for (const evento of eventos) {
    if (evento.campo === 'estado' && evento.tipo === 'CAMBIO_VALIDACION') {
      completa.estado_validacion = evento.valor_nuevo;
      completa.fecha_validacion = evento.created_at;
    }
    if (evento.campo === 'estado_grab') completa.fecha_grabacion = evento.created_at;
    if (evento.modulo === 'Seguimiento') completa.fecha_seguimiento = evento.created_at;
  }
  return completa;
}

let expiracionProgramacionesEnCurso = null;
let ultimaExpiracionProgramaciones = 0;

async function expirarProgramacionesVencidas() {
  if (Date.now() - ultimaExpiracionProgramaciones < 30000) return;
  if (expiracionProgramacionesEnCurso) return expiracionProgramacionesEnCurso;
  ultimaExpiracionProgramaciones = Date.now();
  expiracionProgramacionesEnCurso = db.query(`
    UPDATE ventas
       SET estado = 'VALIDADO',
           estado_supgrab = 'no_conforme',
           estado_grab = 'pendiente',
           programacion_expira_at = NULL
     WHERE LOWER(TRIM(COALESCE(estado_supgrab, ''))) = 'programado'
       AND programacion_expira_at IS NOT NULL
       AND programacion_expira_at <= NOW()
  `).catch(error => {
    console.error('[EXPIRAR PROGRAMACIONES]', error.message);
  }).finally(() => {
    expiracionProgramacionesEnCurso = null;
  });
  return expiracionProgramacionesEnCurso;
}

function actualizarDocumentoEnTexto(texto, documento) {
  const actual = String(texto || '').trim();
  const patron = /\b(?:DNI|CE|RUC)\s*:\s*\d+/gi;
  if (!documento) return actual.replace(patron, '').replace(/^\s*\|\s*|\s*\|\s*$/g, '').trim();
  if (patron.test(actual)) return actual.replace(patron, documento);
  return actual ? `${actual} | ${documento}` : documento;
}

async function sincronizarDocumentoConBackData(conn, venta, tipoDocNuevo, dniNuevo, telefonoNuevo) {
  const tipo = String(tipoDocNuevo || venta.tipo_doc || 'DNI').trim().toUpperCase();
  const numeroDoc = String(dniNuevo ?? venta.dni ?? '').trim();
  const documento = numeroDoc ? `${tipo}: ${numeroDoc}` : '';
  const telefonos = [...new Set([venta.telefono1, telefonoNuevo].map(v => String(v || '').replace(/\D/g, '')).filter(Boolean))];
  if (!telefonos.length) return 0;
  const condiciones = telefonos.map(() => `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(n1,' ',''),'-',''),'(',''),')',''),'+',''),'.','')=?`).join(' OR ');
  const [leads] = await conn.query(`SELECT id, obs_asesor, historial FROM leads WHERE ${condiciones} FOR UPDATE`, telefonos);
  for (const lead of leads) {
    let historial = [];
    try { historial = JSON.parse(lead.historial || '[]'); } catch { historial = []; }
    historial = historial.map(item => {
      if (!item || typeof item !== 'object') return item;
      const actualizado = { ...item };
      if (Number(item.ventaId) === Number(venta.id) || item.ventaCompleta === true) actualizado.documento = documento;
      for (const campo of ['obsAsesorPersonal','obsAsesorAntes']) {
        if (actualizado[campo] != null) actualizado[campo] = actualizarDocumentoEnTexto(actualizado[campo], documento);
      }
      return actualizado;
    });
    await conn.query(`UPDATE leads SET obs_asesor=?, historial=? WHERE id=?`, [
      actualizarDocumentoEnTexto(lead.obs_asesor, documento),
      JSON.stringify(historial),
      lead.id,
    ]);
  }
  return leads.length;
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
  let conn;
  try {
    const v = req.body;

    const errores = validar([
      errorTexto(v.nombre,  'nombre',  { requerido: true, max: 150 }),
      errorTexto(v.dni,     'dni',     { requerido: true }),
      errorDni(v.dni, v.tipoDoc || 'DNI'),
      errorTexto(v.email,   'email',   { requerido: true, max: 150 }),
      errorEmail(v.email),
      errorEnum(v.tipoDoc, 'tipoDoc', TIPO_DOC_OK),
      errorTexto(v.telefono1, 'telefono1', { requerido: true, max: 20 }),
      errorTexto(v.telefono2, 'telefono2', { max: 20 }),
      errorTexto(v.departamento, 'departamento', { requerido: true, max: 100 }),
      errorTexto(v.provincia, 'provincia', { requerido: true, max: 100 }),
      errorTexto(v.distrito, 'distrito', { requerido: true, max: 100 }),
      errorTexto(v.direccion, 'direccion', { requerido: true, max: 1000 }),
      errorTexto(v.coordenadas, 'coordenadas', { requerido: true, max: 255 }),
      errorTexto(v.fechaNac, 'fechaNac', { requerido: true, max: 10 }),
      errorFecha(v.fechaNac, 'fechaNac'),
      errorTexto(v.lugarNac, 'lugarNac', { requerido: true, max: 150 }),
      errorTexto(v.padre, 'padre', { requerido: true, max: 150 }),
      errorTexto(v.madre, 'madre', { requerido: true, max: 150 }),
      errorTexto(v.cuotaInstalacion, 'cuotaInstalacion', { requerido: true, max: 100 }),
      errorTexto(v.hogar, 'hogar', { requerido: true, max: 150 }),
      errorTexto(v.tec, 'tecnologia', { requerido: true, max: 100 }),
      errorTexto(v.paquete, 'paquete', { requerido: true, max: 255 }),
      errorTexto(v.full, 'fullClaro', { requerido: true, max: 20 }),
      errorTexto(v.plano, 'plano', { requerido: true, max: 100 }),
      errorTexto(v.obs, 'observacion', { requerido: true, max: 1000 }),
      errorEnteroPositivo(v.cantDecos, 'cantDecos', { max: 10 }),
      errorEnteroPositivo(v.cantMesh,  'cantMesh',  { max: 10 }),
    ]);
    if (errores) return res.status(400).json({ ok: false, mensaje: errores[0], errores });

    if (v.telefono1 && !/^\d+$/.test(String(v.telefono1)))
      return res.status(400).json({ ok: false, mensaje: 'El teléfono de contacto solo puede contener números.' });
    if (v.telefono2 && !/^\d+$/.test(String(v.telefono2)))
      return res.status(400).json({ ok: false, mensaje: 'El teléfono de referencia solo puede contener números.' });

    if (v.telefono2 && String(v.telefono1).trim() === String(v.telefono2).trim())
      return res.status(400).json({ ok: false, mensaje: 'El telefono de referencia debe ser diferente al telefono principal.' });

    if (req.user.cargo === 'asesor' && !v.telefono1)
      return res.status(400).json({ ok: false, mensaje: 'El Teléfono Contacto es obligatorio.' });
    const estadoFinal = req.user.cargo === 'asesor' ? 'VENTA' : (v.estado || 'VENTA').toUpperCase();
    if (!ESTADOS_VALIDOS_POST.includes(estadoFinal))
      return res.status(400).json({ ok: false, mensaje: `Estado inválido al crear. Solo se permite: ${ESTADOS_VALIDOS_POST.join(', ')}` });

    conn = await db.getConnection();
    await conn.beginTransaction();

    let leadVenta = null;
    let cicloVentaAbierto = null;
    let asesorVentaId = Number(req.user.id);
    let nombreAsesor = req.user.nombre || req.user.usuario || 'Asesor';

    // La vista delegada conserva el token de Jefatura/Backoffice. La venta
    // debe pertenecer al asesor asignado al lead, no al usuario administrador.
    if (v.leadId) {
      const [leads] = await conn.query(
        `SELECT * FROM leads WHERE id = ? AND TRIM(n1) = ? FOR UPDATE`,
        [v.leadId, String(v.telefono1).trim()]
      );
      if (!leads.length) {
        await conn.rollback();
        return res.status(400).json({ ok: false, mensaje: 'El número seleccionado no corresponde al lead indicado.' });
      }
      leadVenta = leads[0];
      const [ciclos] = await conn.query(`
        SELECT * FROM lead_ciclos_venta
        WHERE lead_id=? AND estado='ABIERTO'
        ORDER BY id DESC LIMIT 1 FOR UPDATE
      `, [leadVenta.id]);
      cicloVentaAbierto = ciclos[0] || null;

      if (req.user.cargo !== 'asesor') {
        if (!leadVenta.asesor_id) {
          await conn.rollback();
          return res.status(400).json({ ok: false, mensaje: 'El lead no tiene un asesor asignado.' });
        }
        asesorVentaId = Number(leadVenta.asesor_id);
        nombreAsesor = leadVenta.asesor_nombre || nombreAsesor;
      }
    } else if (req.user.cargo !== 'asesor' && (v.asesor_id || v.asesorId)) {
      const asesorSolicitado = Number(v.asesor_id || v.asesorId);
      const [asesores] = await conn.query(
        `SELECT id, nombre FROM usuarios WHERE id = ? AND cargo = 'asesor' AND activo = 1 LIMIT 1`,
        [asesorSolicitado]
      );
      if (!asesores.length) {
        await conn.rollback();
        return res.status(400).json({ ok: false, mensaje: 'El asesor indicado no existe o no está activo.' });
      }
      asesorVentaId = Number(asesores[0].id);
      nombreAsesor = asesores[0].nombre || nombreAsesor;
    }

    if (req.user.cargo === 'asesor') {
      const [usuarios] = await conn.query(`SELECT nombre FROM usuarios WHERE id = ? LIMIT 1`, [req.user.id]);
      nombreAsesor = usuarios[0]?.nombre || nombreAsesor;
      if (leadVenta) {
        let historial = [];
        try { historial = JSON.parse(leadVenta.historial || '[]'); } catch { historial = []; }
        const participo = leadVenta.asesor_id === req.user.id || historial.some(h =>
          (h?.asesor || '').trim() === nombreAsesor.trim() || (h?.asesorAnterior || '').trim() === nombreAsesor.trim()
        );
        if (!participo) {
          await conn.rollback();
          return res.status(403).json({ ok: false, mensaje: 'No puedes registrar una venta con un número que no trabajaste.' });
        }
      } else {
        const valido = await esTelefonoVentaCerradaHoy(conn, req.user.id, v.telefono1);
        if (!valido) {
          await conn.rollback();
          return res.status(400).json({ ok: false, mensaje: 'El teléfono de contacto no corresponde a una VENTA CERRADA del día para este asesor.' });
        }
      }
      const [yaUsado] = await conn.query(
        `SELECT * FROM ventas
          WHERE telefono1 = ?
          ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [String(v.telefono1).trim()]
      );
      const ultimaVenta = yaUsado.length ? await completarEstadoVentaCaida(conn, yaUsado[0]) : null;
      if (ultimaVenta && !ventaEstaCaida(ultimaVenta) && !cicloVentaAbierto) {
        await conn.rollback();
        return res.status(400).json({ ok: false, mensaje: 'Este número ya fue registrado en otra venta. No puede ser usado nuevamente.' });
      }
    }

    const [result] = await conn.query(`
      INSERT INTO ventas (
        asesor_id, asesor_nombre, tipo_doc, dni, nombre, email,
        telefono1, telefono2, departamento, provincia, distrito,
        direccion, coordenadas, fecha_nac, lugar_nac, padre, madre,
        cuota_inst, claro_hogar, tecnologia, paquete,
        full_claro, cant_decos, cant_mesh, plano, estado, observacion,
        lead_id, lead_ciclo_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      asesorVentaId, nombreAsesor, v.tipoDoc||'DNI', v.dni||null, v.nombre||null, v.email||null,
      v.telefono1||null, v.telefono2||null, v.departamento||null,
      v.provincia||null, v.distrito||null, v.direccion||null,
      v.coordenadas||null, v.fechaNac||null, v.lugarNac||null,
      v.padre||null, v.madre||null,
      v.cuotaInstalacion||null, v.hogar||null, v.tec||null,
      v.paquete||null, v.full||null,
      parseInt(v.cantDecos)||0, parseInt(v.cantMesh)||0,
      v.plano||null, estadoFinal, v.obs||null,
      leadVenta?.id || null, cicloVentaAbierto?.id || null
    ]);

    if (leadVenta) {
      let historial = [];
      try { historial = JSON.parse(leadVenta.historial || '[]'); } catch { historial = []; }
      const ahora = new Date();
      const peru = new Date(ahora.getTime() + ahora.getTimezoneOffset()*60000 + (-5*60*60000));
      const hora = String(peru.getHours()).padStart(2,'0') + ':' + String(peru.getMinutes()).padStart(2,'0');
      const fecha = fechaPeruHoy();
      historial.push({
        tipo: 'TIPIF_VEND', asesor: nombreAsesor, tipif: 'VENTA CERRADA',
        ts: Date.now(), hora, fecha, ventaCompleta: true, ventaId: result.insertId,
        cicloId:cicloVentaAbierto?.id || null, numeroCiclo:cicloVentaAbierto?.numero_ciclo || 1,
      });
      if (cicloVentaAbierto) {
        historial.push({
          tipo:'CICLO_VENTA', subtipo:'OTRA_DIRECCION', accion:'CIERRE',
          cicloId:cicloVentaAbierto.id, numeroCiclo:cicloVentaAbierto.numero_ciclo,
          ventaId:result.insertId, asesor:nombreAsesor, direccion:v.direccion || '', distrito:v.distrito || '',
          realizadoPor:nombreAsesor, realizadoPorUsuario:req.user.usuario || '', realizadoPorId:req.user.id,
          fecha, hora, ts:Date.now(),
        });
        await conn.query(`UPDATE lead_ciclos_venta SET estado='CERRADO', venta_id=?, cerrado_at=NOW() WHERE id=?`, [result.insertId, cicloVentaAbierto.id]);
      }
      for (let i = historial.length - 2; i >= 0; i--) {
        const h = historial[i];
        if ((h?.asesorAnterior || '').trim() === nombreAsesor.trim()) {
          h.tipifVendAntes = 'VENTA CERRADA';
          break;
        }
      }
      const doc = `${v.tipoDoc || 'DNI'}: ${String(v.dni || '').trim()}`;
      const obsFinal = doc;
      await conn.query(
        `UPDATE leads SET asesor_id=?, asesor_nombre=?, sin_asignar=0, tipif_vend='VENTA CERRADA', tipif_hora=?, obs_asesor=?, historial=? WHERE id=?`,
        [asesorVentaId, nombreAsesor, hora, obsFinal, JSON.stringify(historial), leadVenta.id]
      );
    }

    await conn.commit();
    res.json({ ok: true, id: result.insertId, asesor_id: asesorVentaId, mensaje: 'Venta guardada' });
  } catch(e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al guardar venta' });
  } finally {
    if (conn) conn.release();
  }
});

let promesaTablaCalidad;
function asegurarTablaCalidad() {
  if (!promesaTablaCalidad) {
    promesaTablaCalidad = db.query(`
      CREATE TABLE IF NOT EXISTS calidad_gestiones (
        venta_id INT NOT NULL PRIMARY KEY,
        llamada VARCHAR(40) NOT NULL DEFAULT 'PENDIENTE',
        whatsapp VARCHAR(40) NOT NULL DEFAULT 'PENDIENTE',
        servicio_internet VARCHAR(80) NOT NULL DEFAULT 'PENDIENTE',
        servicio_instalacion VARCHAR(80) NOT NULL DEFAULT 'PENDIENTE',
        ofrecieron_adicionales VARCHAR(60) NOT NULL DEFAULT 'PENDIENTE',
        adicional VARCHAR(40) NOT NULL DEFAULT 'PENDIENTE',
        estado_cliente VARCHAR(60) NOT NULL DEFAULT 'PENDIENTE',
        actualizado_por_id INT NULL,
        actualizado_por_nombre VARCHAR(150) NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(error => { promesaTablaCalidad = null; throw error; });
  }
  return promesaTablaCalidad;
}

// Listado de solo lectura para Cobranzas. Una venta entra desde el momento en
// que alcanzó por primera vez un estado de instalación y permanece disponible
// aunque luego avance a otro estado operativo.
router.get('/cobranzas-listado', auth(['cobranzas','calidad','jefatura']), async (req, res) => {
  try {
    // Jefatura puede supervisar estos campos únicamente al entrar al módulo
    // mediante Accesos directos; la escritura continúa reservada a Calidad.
    const incluyeCalidad = req.user.cargo === 'calidad';
    if (incluyeCalidad) await asegurarTablaCalidad();
    const camposCalidad = incluyeCalidad ? `,
             COALESCE(cg.llamada, 'PENDIENTE') AS calidad_llamada,
             COALESCE(cg.whatsapp, 'PENDIENTE') AS calidad_whatsapp,
             COALESCE(cg.servicio_internet, 'PENDIENTE') AS calidad_servicio_internet,
             COALESCE(cg.servicio_instalacion, 'PENDIENTE') AS calidad_servicio_instalacion,
             COALESCE(cg.ofrecieron_adicionales, 'PENDIENTE') AS calidad_ofrecieron_adicionales,
             COALESCE(cg.adicional, 'PENDIENTE') AS calidad_adicional,
             COALESCE(cg.estado_cliente, 'PENDIENTE') AS calidad_estado_cliente` : '';
    const joinCalidad = incluyeCalidad ? 'LEFT JOIN calidad_gestiones cg ON cg.venta_id = v.id' : '';
    const [data] = await db.query(`
      SELECT v.id, v.nombre, v.dni, v.sot, v.telefono1, v.telefono2, v.paquete${camposCalidad},
             COALESCE(inst.fecha_instalacion,
               CASE WHEN REPLACE(UPPER(TRIM(COALESCE(v.estado, ''))), '_', ' ') IN
                 ('INSTALADO', 'INSTALADO NO VALIDADO', 'REASIGNACION', 'SERVICIO ACTIVO')
               THEN v.created_at END
             ) AS fecha_instalacion
        FROM ventas v
        ${joinCalidad}
        LEFT JOIN (
          SELECT venta_id, MIN(created_at) AS fecha_instalacion
            FROM venta_historial
           WHERE campo = 'estado'
             AND REPLACE(UPPER(TRIM(COALESCE(valor_nuevo, ''))), '_', ' ') IN
                 ('INSTALADO', 'INSTALADO NO VALIDADO', 'REASIGNACION', 'SERVICIO ACTIVO')
           GROUP BY venta_id
        ) inst ON inst.venta_id = v.id
       WHERE inst.fecha_instalacion IS NOT NULL
          OR REPLACE(UPPER(TRIM(COALESCE(v.estado, ''))), '_', ' ') IN
             ('INSTALADO', 'INSTALADO NO VALIDADO', 'REASIGNACION', 'SERVICIO ACTIVO')
       ORDER BY fecha_instalacion DESC, v.id DESC
    `);
    res.json({ ok: true, data });
  } catch (e) {
    console.error('[GET /ventas/cobranzas-listado]', e.message || e);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener clientes instalados' });
  }
});

const CALIDAD_CAMPOS = {
  llamada: ['PENDIENTE','CONTESTA','NO CONTESTA','APAGADO','CORTA LLAMADA'],
  whatsapp: ['PENDIENTE','SE ENVIA','TIENE','NO TIENE'],
  servicio_internet: ['PENDIENTE','TODO CORRECTO','INTERMITENCIAS CON EL SERVICIO','NO RECONOCE LA TITULARIDAD','NO ES LA MISMA VELOCIDAD CONTRATADA','PROBLEMA SOLUCIONADO','OTROS'],
  servicio_instalacion: ['PENDIENTE','TODO CORRECTO','INTERMITENCIAS CON EL SERVICIO','NO RECONOCE LA TITULARIDAD','NO ES LA MISMA VELOCIDAD CONTRATADA','PROBLEMA SOLUCIONADO','OTROS'],
  ofrecieron_adicionales: ['PENDIENTE','NO','SI','SI, PERO NO SE BRINDO'],
  adicional: ['PENDIENTE','IPTV','NETFLIX','STAR+','DISNEY+','OTROS','CRUNCHYROLL','REPETIDOR'],
  estado_cliente: ['PENDIENTE','SATISFECHO','REGULAR','INSATISFECHO','OBSERVADO','NO RECONOCE EL SERVICIO','BAJA'],
};

router.patch('/calidad/:id', auth(['calidad']), async (req, res) => {
  try {
    if (req.user.cargo !== 'calidad' || req.user.accesoDirectoJefatura) {
      return res.status(403).json({ ok:false, mensaje:'Esta gestión es exclusiva del área de Calidad' });
    }
    await asegurarTablaCalidad();
    const ventaId = Number(req.params.id);
    const campo = String(req.body?.campo || '').trim();
    const valor = String(req.body?.valor || '').trim().toUpperCase();
    if (!Number.isInteger(ventaId) || ventaId <= 0 || !CALIDAD_CAMPOS[campo] || !CALIDAD_CAMPOS[campo].includes(valor)) {
      return res.status(400).json({ ok:false, mensaje:'Tipificación de Calidad no válida' });
    }
    const [venta] = await db.query('SELECT id FROM ventas WHERE id=? LIMIT 1', [ventaId]);
    if (!venta.length) return res.status(404).json({ ok:false, mensaje:'Cliente no encontrado' });
    await db.query(`
      INSERT INTO calidad_gestiones (venta_id, ${campo}, actualizado_por_id, actualizado_por_nombre)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE ${campo}=VALUES(${campo}), actualizado_por_id=VALUES(actualizado_por_id),
        actualizado_por_nombre=VALUES(actualizado_por_nombre), updated_at=CURRENT_TIMESTAMP
    `, [ventaId, valor, req.user.id, req.user.nombre || req.user.usuario || 'Calidad']);
    res.json({ ok:true, campo, valor });
  } catch (e) {
    console.error('[PATCH /ventas/calidad/:id]', e.message || e);
    res.status(500).json({ ok:false, mensaje:'Error al guardar la tipificación de Calidad' });
  }
});

// Listado ligero exclusivo de Validación. Evita las subconsultas operativas de
// Programación, Seguimiento, WhatsApp y Grabaciones que esta pantalla no usa.
router.get('/validacion-listado', auth(['validacion','jefatura']), async (req, res) => {
  try {
    const [data] = await db.query(`
      SELECT v.*, COALESCE(u.nombre, v.asesor_nombre) AS asesor_nombre, u.sala,
             COALESCE(LOWER((
               SELECT vh.valor_nuevo
                 FROM venta_historial vh
                WHERE vh.venta_id = v.id
                  AND vh.campo = 'estado'
                  AND vh.tipo = 'CAMBIO_VALIDACION'
                ORDER BY vh.id DESC
                LIMIT 1
             )), 'venta') AS estado_validacion
        FROM ventas v
        LEFT JOIN usuarios u ON v.asesor_id = u.id
       ORDER BY v.created_at DESC
    `);
    res.json({ ok: true, data });
  } catch (e) {
    console.error('[GET /ventas/validacion-listado]', e.message || e);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener ventas para Validación' });
  }
});

// ===== GET /api/ventas =====
router.get('/', auth(ROLES_VENTAS), async (req, res) => {
  try {
    const { dni, estado, desde, hasta, asesor_id, programacion, alcance, area, seguimiento_campo } = req.query;
    const permisosUsuario = Array.isArray(req.user.permisos) ? req.user.permisos : [];
    if (area && area !== req.user.cargo && !permisosUsuario.includes(area)) {
      return res.status(403).json({ ok: false, mensaje: 'Sin permiso para consultar esta área' });
    }
    const cargoEfectivo = area || req.user.cargo;
    // Aislamiento estricto por usuario, cargo, permisos y consulta completa.
    // Evita ráfagas duplicadas de focus/poll sin mezclar respuestas privadas.
    const cacheClave = `${req.user.id}|${req.user.cargo}|${JSON.stringify(permisosUsuario)}|${req.originalUrl}`;
    const cacheHit = cacheVentasGet(cacheClave);
    if (cacheHit) return res.json(cacheHit);

    // Una venta PROGRAMADA espera como máximo dos horas la decisión de
    // Sup. Grabaciones. Al vencer vuelve a la cola de Grabaciones.
    await expirarProgramacionesVencidas();

    const errores = validar([
      errorFecha(desde, 'desde'),
      errorFecha(hasta, 'hasta'),
      asesor_id ? errorId(asesor_id, 'asesor_id') : null,
    ]);
    if (errores) return res.status(400).json({ ok: false, mensaje: errores[0] });

    // fecha_programado: momento real (venta_historial) en que Programación
    // puso estado=PROGRAMADO — no la hora del servidor. Agregado en una sola
    // subconsulta agrupada (no una consulta por fila) para que Super de
    // Grabaciones pueda mostrar "PROGRAMADO: HH:mm / DD/MM/YYYY" cuando el
    // audio todavía no está subido.
    let sql = `SELECT v.*, COALESCE(u.nombre, v.asesor_nombre) as asesor_nombre, u.sala, g.nombre as grabando_por_nombre,
               ph.fecha_programado,
               ph_prog.estado_prog, ph_prog.usuario_prog, ph_prog.fecha_prog,
               ph_sup.fecha_sup_resultado,
               ph_inst.fecha_instalado,
               ph_caida.fecha_caida,
               ph_wa.fecha_whatsapp_enviado,
               COALESCE(LOWER(cv.estado_validacion), 'venta') AS estado_validacion
               FROM ventas v
               LEFT JOIN usuarios u ON v.asesor_id = u.id
               LEFT JOIN usuarios g ON v.grabando_por_id = g.id
               LEFT JOIN (
                 SELECT venta_id, MAX(created_at) AS fecha_programado
                 FROM venta_historial
                 WHERE campo = 'estado' AND UPPER(valor_nuevo) = 'PROGRAMADO'
                 GROUP BY venta_id
               ) ph ON ph.venta_id = v.id
               LEFT JOIN (
                 -- Ultima vez que el estado paso a un valor de instalacion.
                 SELECT venta_id, MAX(created_at) AS fecha_instalado
                 FROM venta_historial
                 WHERE campo = 'estado'
                   AND REPLACE(UPPER(valor_nuevo), '_', ' ') IN ('INSTALADO', 'INSTALADO NO VALIDADO', 'REASIGNACION')
                 GROUP BY venta_id
               ) ph_inst ON ph_inst.venta_id = v.id
               LEFT JOIN (
                 -- Ultima vez que el estado paso a un valor de caida/rechazo.
                 SELECT venta_id, MAX(created_at) AS fecha_caida
                 FROM venta_historial
                 WHERE campo = 'estado'
                   AND REPLACE(UPPER(valor_nuevo), '_', ' ') IN
                       ('CAIDA', 'RECHAZO', 'RECHAZO CAMPO', 'RECHAZO MESA', 'RECHAZADA', 'RECHAZADO', 'ANULADA', 'SERVICIO ACTIVO')
                 GROUP BY venta_id
               ) ph_caida ON ph_caida.venta_id = v.id
               LEFT JOIN (
                 SELECT venta_id, MAX(created_at) AS fecha_whatsapp_enviado
                 FROM venta_historial
                 WHERE tipo = 'WHATSAPP'
                 GROUP BY venta_id
               ) ph_wa ON ph_wa.venta_id = v.id
               LEFT JOIN (
                 SELECT h1.venta_id, h1.valor_nuevo AS estado_prog,
                        h1.usuario_nombre AS usuario_prog, h1.created_at AS fecha_prog
                 FROM venta_historial h1
                 INNER JOIN (
                   SELECT venta_id, MAX(id) AS max_id
                   FROM venta_historial
                   WHERE campo = 'estado'
                     AND (modulo = 'Programación' OR UPPER(valor_nuevo) = 'PROGRAMADO')
                   GROUP BY venta_id
                 ) h2 ON h1.id = h2.max_id
               ) ph_prog ON ph_prog.venta_id = v.id
               LEFT JOIN (
                 SELECT h1.venta_id, h1.created_at AS fecha_sup_resultado
                 FROM venta_historial h1
                 INNER JOIN (
                   SELECT venta_id, MAX(id) AS max_id
                   FROM venta_historial
                   WHERE campo = 'estado_supgrab'
                     AND LOWER(valor_nuevo) IN ('no_conforme', 'observado')
                   GROUP BY venta_id
                 ) h2 ON h1.id = h2.max_id
               ) ph_sup ON ph_sup.venta_id = v.id
               LEFT JOIN (
                 SELECT vh.venta_id, vh.valor_nuevo AS estado_validacion
                 FROM venta_historial vh
                 INNER JOIN (
                   SELECT venta_id, MAX(id) AS max_id
                   FROM venta_historial
                   WHERE campo = 'estado' AND tipo = 'CAMBIO_VALIDACION'
                   GROUP BY venta_id
                 ) lcv ON vh.id = lcv.max_id
               ) cv ON cv.venta_id = v.id
               WHERE 1=1`;
    const params = [];

    if (cargoEfectivo === 'asesor') {
      sql += ` AND v.asesor_id = ?`; params.push(req.user.id);
    } else if (asesor_id) {
      sql += ` AND v.asesor_id = ?`; params.push(asesor_id);
    }

    if (alcance === 'sala') {
      const actor = await obtenerActor(db, req.user.id);
      const permisos = Array.isArray(req.user.permisos) ? req.user.permisos : [];
      if (!actor || (req.user.cargo !== 'supervisor' && !permisos.includes('supervisor'))) {
        return res.status(403).json({ ok: false, mensaje: 'Sin permiso para consultar ventas por sala' });
      }
      if (!salaNormalizada(actor.sala)) {
        return res.json({ ok: true, data: [] });
      }
      sql += ` AND UPPER(TRIM(COALESCE(u.sala, ''))) = ?`;
      params.push(salaNormalizada(actor.sala));
    }

    if (cargoEfectivo === 'grabaciones') {
      sql += ` AND UPPER(v.estado) = 'VALIDADO'`;
    }

    if (cargoEfectivo === 'seguimiento') {
      sql += ` AND LOWER(TRIM(COALESCE(v.estado_supgrab, ''))) = 'conforme'`;
    }

    if (seguimiento_campo === '1') {
      sql += ` AND UPPER(TRIM(v.estado)) IN ('EN_EJECUCION','INSTALADO','CAIDA','RECHAZO_CAMPO','TECNICO_CASA','LEVANTAR_SOT','TECNICOS_CAMINO','INSTALADO_NO_VALIDADO','REASIGNACION','DERIVADO_PLANTA_EXTERNA','SERVICIO_ACTIVO','RECHAZO_MESA')`;
    }

    if (cargoEfectivo === 'programacion' || programacion === '1') {
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
    const payload = { ok: true, data };
    cacheVentasSet(cacheClave, payload);
    res.json(payload);
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
    const [rows] = await db.query(`SELECT id, asesor_id, estado, audio_path FROM ventas WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Venta no encontrada' });
    if (!req.file)    return res.status(400).json({ ok: false, mensaje: 'No se recibio archivo' });

    const areaSolicitada = String(req.query.area || '').trim().toLowerCase();
    const permisosUsuario = Array.isArray(req.user.permisos) ? req.user.permisos : [];
    if (areaSolicitada && areaSolicitada !== req.user.cargo && !permisosUsuario.includes(areaSolicitada)) {
      return res.status(403).json({ ok: false, mensaje: 'Sin permiso para operar en esta área' });
    }
    const cargoEfectivo = areaSolicitada || req.user.cargo;

    if (cargoEfectivo === 'grabaciones' && String(rows[0].estado || '').toUpperCase() !== 'VALIDADO') {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ ok: false, mensaje: 'Solo puedes grabar ventas con estado VALIDADO' });
    }

    // Asesor solo puede subir audio de sus propias ventas
    if (req.user.cargo === 'asesor' && rows[0].asesor_id !== req.user.id) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ ok: false, mensaje: 'No puedes subir audio de ventas de otros asesores' });
    }

    // Verificar bytes reales del archivo
    if (!esArchivoMp3Valido(req.file.path)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ ok: false, mensaje: 'El archivo debe ser un MP3 válido' });
    }

    const rutaRelativa = 'uploads/audios/' + req.file.filename;
    await db.query(`UPDATE ventas SET audio_path = ? WHERE id = ?`, [rutaRelativa, req.params.id]);
    const audioAnterior = String(rows[0].audio_path || '').trim();
    if (audioAnterior) {
      const rutaAnterior = path.join(audioDir, path.basename(audioAnterior));
      if (fs.existsSync(rutaAnterior)) {
        try { fs.unlinkSync(rutaAnterior); } catch (e) { console.warn('No se pudo borrar el audio reemplazado:', e.message); }
      }
    }
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

// ===== DELETE /api/ventas/:id/audio =====
// Elimina solo el archivo de audio y reinicia su revisión para permitir reemplazarlo.
router.delete('/:id/audio', auth(ROLES_VENTAS), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, asesor_id, audio_path FROM ventas WHERE id = ?`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Venta no encontrada' });

    const areaSolicitada = String(req.query.area || '').trim().toLowerCase();
    const permisosUsuario = Array.isArray(req.user.permisos) ? req.user.permisos : [];
    if (areaSolicitada && areaSolicitada !== req.user.cargo && !permisosUsuario.includes(areaSolicitada)) {
      return res.status(403).json({ ok: false, mensaje: 'Sin permiso para operar en esta área' });
    }
    const cargoEfectivo = areaSolicitada || req.user.cargo;
    if (!['grabaciones','jefatura'].includes(cargoEfectivo)) {
      return res.status(403).json({ ok: false, mensaje: 'Solo Grabaciones puede eliminar audios' });
    }

    const audioAnterior = String(rows[0].audio_path || '').trim();
    if (!audioAnterior) return res.status(400).json({ ok: false, mensaje: 'La venta no tiene audio para eliminar' });

    await db.query(
      `UPDATE ventas
          SET audio_path = NULL,
              estado_grab = 'pendiente',
              estado_supgrab = 'sin_revisar'
        WHERE id = ?`,
      [req.params.id]
    );

    const rutaAudio = path.join(audioDir, path.basename(audioAnterior));
    if (fs.existsSync(rutaAudio)) {
      try { fs.unlinkSync(rutaAudio); } catch (e) { console.warn('No se pudo borrar el archivo de audio:', e.message); }
    }

    const actor = await obtenerActor(db, req.user.id);
    await registrarHistorial(db, req.params.id, actor, {
      tipo: 'ARCHIVO',
      campo: 'audio_path',
      valorAnterior: path.basename(audioAnterior),
      valorNuevo: null,
      descripcion: 'Se eliminó la grabación para permitir subir un nuevo archivo MP3.',
    });

    res.json({ ok: true, mensaje: 'Audio eliminado' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al eliminar audio' });
  }
});

// ===== PATCH /api/ventas/:id/tipificar-validacion =====
// Endpoint dedicado para Validación: append al historial server-side,
// control de concurrencia (estadoAnteriorEsperado), usuario desde req.user.
const TIPS_VALIDACION = ['corta_llamada','fraude','no_desea','no_contesta','buzon_voz','servicio_activo','corregir','mala_oferta','venta','validado'];
const TIP_LABELS_VAL  = {
  corta_llamada:   'CORTA LLAMADA',
  fraude:          'FRAUDE',
  no_desea:        'NO DESEA',
  no_contesta:     'NO CONTESTA',
  buzon_voz:       'BUZÓN DE VOZ',
  servicio_activo: 'SERVICIO ACTIVO',
  corregir:        'CORREGIR',
  mala_oferta:     'MALA OFERTA',
  venta:           'VENTA',
  validado:        'VALIDADO',
};
const TIP_TO_ESTADO_VAL = {
  validado:        'VALIDADO',
  corta_llamada:   'CORTA_LLAMADA',
  fraude:          'FRAUDE',
  no_desea:        'NO_DESEA',
  no_contesta:     'NO_CONTESTA',
  buzon_voz:       'BUZON_VOZ',
  servicio_activo: 'SERVICIO_ACTIVO',
  corregir:        'CORREGIR',
  mala_oferta:     'MALA_OFERTA',
  venta:           'VENTA',
};

function nowPeruLabel() {
  const now  = new Date();
  const p    = new Date(now.getTime() + (-5 * 3600 * 1000));
  const pad  = n => String(n).padStart(2, '0');
  const hh   = p.getUTCHours();
  const h12  = hh % 12 || 12;
  const ampm = hh >= 12 ? 'p. m.' : 'a. m.';
  return `${pad(p.getUTCDate())}/${pad(p.getUTCMonth()+1)}/${p.getUTCFullYear()}, ${h12}:${pad(p.getUTCMinutes())} ${ampm}`;
}

router.patch('/:id/tipificar-validacion', auth(['validacion','jefatura']), async (req, res) => {
  const ventaId = Number(req.params.id);
  if (!Number.isInteger(ventaId) || ventaId <= 0)
    return res.status(400).json({ ok: false, mensaje: 'ID de venta no válido.' });

  const { tipificacion, observacion, estadoAnteriorEsperado } = req.body;
  const obsTexto = String(observacion || '').trim();

  if (tipificacion && !TIPS_VALIDACION.includes(tipificacion))
    return res.status(400).json({ ok: false, mensaje: 'Tipificación inválida.' });
  if (!tipificacion && !obsTexto)
    return res.status(400).json({ ok: false, mensaje: 'Selecciona una tipificación o escribe una observación.' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT id, estado, obs_validacion FROM ventas WHERE id = ? FOR UPDATE`,
      [ventaId]
    );
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ ok: false, mensaje: 'Venta no encontrada.' });
    }
    const venta = rows[0];

    // Guardia: VENTA solo puede aplicarse desde estados propios de Validación
    if (tipificacion === 'venta') {
      const ESTADOS_PROPIOS_VAL = new Set([
        'VENTA','CORTA_LLAMADA','FRAUDE','NO_DESEA','NO_CONTESTA',
        'BUZON_VOZ','SERVICIO_ACTIVO','CORREGIR','MALA_OFERTA',
      ]);
      if (!ESTADOS_PROPIOS_VAL.has((venta.estado || 'VENTA').toUpperCase())) {
        await conn.rollback();
        return res.status(409).json({
          ok: false,
          mensaje: 'Esta venta ya avanzó en el flujo. No se puede revertir a VENTA desde Validación.',
        });
      }
    }

    // Control de concurrencia optimista
    if (estadoAnteriorEsperado != null) {
      const estadoActualDB = (venta.estado || 'VENTA').toLowerCase();
      const estadoEsperado = (estadoAnteriorEsperado || 'venta').toLowerCase();
      if (estadoActualDB !== estadoEsperado) {
        await conn.rollback();
        return res.status(409).json({
          ok: false,
          mensaje: 'Esta venta fue modificada por otro validador. Se actualizaron los datos; revisa el historial antes de guardar nuevamente.',
          estadoActual: estadoActualDB,
        });
      }
    }

    const ts           = nowPeruLabel();
    const nombreUsuario = req.user.nombre || req.user.usuario;
    const lineas       = (venta.obs_validacion || '').split('\n').filter(l => l.trim());

    if (tipificacion) lineas.push(`[${ts} - ${nombreUsuario}] ${TIP_LABELS_VAL[tipificacion]}`);
    if (obsTexto)     lineas.push(`[${ts} - ${nombreUsuario}] ${obsTexto}`);

    // VALIDADO cierra las observaciones operativas de Validación. Los cambios
    // anteriores siguen disponibles en venta_historial para auditoría.
    const nuevoHistorialTexto = tipificacion === 'validado' ? '' : lineas.join('\n');
    const nuevoEstado         = tipificacion ? TIP_TO_ESTADO_VAL[tipificacion] : null;
    const estadoAnterior      = venta.estado || 'VENTA';

    if (nuevoEstado) {
      await conn.query(
        `UPDATE ventas SET estado = ?, obs_validacion = ? WHERE id = ?`,
        [nuevoEstado, nuevoHistorialTexto, ventaId]
      );
    } else {
      await conn.query(
        `UPDATE ventas SET obs_validacion = ? WHERE id = ?`,
        [nuevoHistorialTexto, ventaId]
      );
    }

    const actor = await obtenerActor(conn, req.user.id);
    if (!actor) throw new Error('No se encontró el actor autenticado.');

    if (nuevoEstado) {
      await registrarHistorial(conn, ventaId, actor, {
        tipo:          'CAMBIO_VALIDACION',
        campo:         'estado',
        etiqueta:      'Estado de la venta',
        valorAnterior: estadoAnterior,
        valorNuevo:    nuevoEstado,
        descripcion:   obsTexto || null,
      });
    }
    await registrarHistorial(conn, ventaId, actor, {
      tipo:          'CAMBIO_VALIDACION',
      campo:         'obs_validacion',
      etiqueta:      'Tipificación de Validación',
      valorAnterior: estadoAnterior,
      valorNuevo:    nuevoEstado || estadoAnterior,
      descripcion:   tipificacion
        ? `${TIP_LABELS_VAL[tipificacion]}${obsTexto ? ': ' + obsTexto : ''}`
        : `Observación: ${obsTexto}`,
    });

    await conn.commit();

    const [ventaRows] = await conn.query(`
      SELECT v.*, COALESCE(u.nombre, v.asesor_nombre) AS asesor_nombre, u.sala,
             COALESCE(LOWER((
               SELECT vh.valor_nuevo
                 FROM venta_historial vh
                WHERE vh.venta_id = v.id
                  AND vh.campo = 'estado'
                  AND vh.tipo = 'CAMBIO_VALIDACION'
                ORDER BY vh.id DESC
                LIMIT 1
             )), 'venta') AS estado_validacion
        FROM ventas v
        LEFT JOIN usuarios u ON v.asesor_id = u.id
       WHERE v.id = ?
    `, [ventaId]);

    res.json({ ok: true, venta: ventaRows[0] || null, mensaje: 'Tipificación guardada' });
  } catch (e) {
    await conn.rollback().catch(() => {});
    console.error('[PATCH /tipificar-validacion]', e.message || e);
    res.status(500).json({ ok: false, mensaje: 'Error al guardar tipificación.' });
  } finally {
    conn.release();
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
             estado_supgrab, estado_grab, audio_path, obs_seguimiento,
             tramo_seguimiento, motivo_seguimiento
        FROM ventas
       WHERE id = ?
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Venta no encontrada' });

    const areaSolicitada = String(req.query.area || '').trim().toLowerCase();
    const permisosUsuario = Array.isArray(req.user.permisos) ? req.user.permisos : [];
    if (areaSolicitada && areaSolicitada !== req.user.cargo && !permisosUsuario.includes(areaSolicitada)) {
      return res.status(403).json({ ok: false, mensaje: 'Sin permiso para operar en esta área' });
    }
    const cargoEfectivo = areaSolicitada || req.user.cargo;

    if (cargoEfectivo === 'grabaciones' && String(rows[0].estado || '').toUpperCase() !== 'VALIDADO') {
      return res.status(403).json({ ok: false, mensaje: 'Solo puedes gestionar ventas con estado VALIDADO' });
    }

    if (cargoEfectivo === 'seguimiento' && String(rows[0].estado_supgrab || '').trim().toLowerCase() !== 'conforme') {
      return res.status(403).json({ ok: false, mensaje: 'Solo puedes gestionar ventas marcadas como CONFORME' });
    }

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

    if (estado_grab !== undefined
        && String(estado_grab).toLowerCase() === 'grabado'
        && !String(rows[0].audio_path || '').trim()) {
      return res.status(400).json({ ok: false, mensaje: 'Debes subir un archivo MP3 antes de marcar la venta como GRABADO' });
    }

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
    // CAMBIO 5: al marcar conforme, no pisar estado si la venta ya avanzó más allá de VALIDADO
    let _estadoAplicar = estado;
    if (
      estado !== undefined &&
      String(estado).toUpperCase() === 'EN_EJECUCION' &&
      estado_supgrab !== undefined &&
      String(estado_supgrab).toLowerCase() === 'conforme'
    ) {
      const estadoActual = String(rows[0].estado || '').toUpperCase();
      const PRE_EJECUCION = new Set(['VENTA','GRABADO','APROBADO','VALIDADO','PROGRAMADO']);
      if (!PRE_EJECUCION.has(estadoActual)) _estadoAplicar = undefined;
    }
    // Guardia no_conforme: solo revertir a VALIDADO si la venta está en VALIDADO o APROBADO
    if (
      estado !== undefined &&
      String(estado).toUpperCase() === 'VALIDADO' &&
      estado_supgrab !== undefined &&
      String(estado_supgrab).toLowerCase() === 'no_conforme'
    ) {
      const estadoActual = String(rows[0].estado || '').toUpperCase();
      const PRE_NOCONFORME = new Set(['VALIDADO', 'APROBADO']);
      if (!PRE_NOCONFORME.has(estadoActual)) _estadoAplicar = undefined;
    }
    // Guardia RECHAZADO de Programación: solo revertir a VALIDADO si la venta está en un estado de Programación
    if (
      estado !== undefined &&
      String(estado).toUpperCase() === 'VALIDADO' &&
      cargoEfectivo === 'programacion' &&
      estado_supgrab !== undefined &&
      String(estado_supgrab).toLowerCase() === 'sin_revisar'
    ) {
      const estadoActual = String(rows[0].estado || '').toUpperCase();
      const ESTADOS_PROG_VAL = new Set(['VALIDADO','APROBADO','PROGRAMADO','PENDIENTE','BLOQUEADO','SIN_AGENDA','CARACTER_ESPECIAL']);
      if (!ESTADOS_PROG_VAL.has(estadoActual)) _estadoAplicar = undefined;
    }
    agregarCambio('estado', _estadoAplicar);
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
      if (estado_supgrab === undefined) campos.push("estado_supgrab = 'programado'");
      if (estado_grab === undefined) campos.push("estado_grab = 'grabado'");
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
    const actorDelArea = actor ? { ...actor, cargo: cargoEfectivo } : actor;
    for (const cambio of cambios) {
      await registrarHistorial(conn, req.params.id, actorDelArea, cambio);
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

// ===== PATCH /api/ventas/:id/datos — editar datos básicos del cliente =====
// Solo modifica campos del cliente (nombre, DNI, teléfono, dirección, paquete, etc.)
// No toca: estado, estado_grab, estado_supgrab, observaciones operativas, audio.
router.patch('/:id/datos', auth(['supervisor','jefatura','seguimiento','usuarios']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    const ventaId = Number(req.params.id);
    if (!Number.isInteger(ventaId) || ventaId <= 0)
      return res.status(400).json({ ok: false, mensaje: 'ID de venta inválido.' });

    const {
      nombre, tipoDoc, dni, email,
      telefono1, telefono2,
      departamento, provincia, distrito, direccion, coordenadas,
      paquete, cuotaInstalacion, hogar, tec, full, plano,
      fechaNac, lugarNac, padre, madre,
      cantDecos, cantMesh,
      observacion,
    } = req.body;

    const errores = validar([
      errorTexto(nombre,         'nombre',         { max: 150 }),
      errorTexto(dni,            'dni',            { max: 20  }),
      errorTexto(email,          'email',          { max: 150 }),
      errorTexto(telefono1,      'telefono1',      { max: 20  }),
      errorTexto(telefono2,      'telefono2',      { max: 20  }),
      errorTexto(departamento,   'departamento',   { max: 100 }),
      errorTexto(provincia,      'provincia',      { max: 100 }),
      errorTexto(distrito,       'distrito',       { max: 100 }),
      errorTexto(direccion,      'direccion',      { max: 1000}),
      errorTexto(coordenadas,    'coordenadas',    { max: 255 }),
      errorTexto(paquete,        'paquete',        { max: 100 }),
      errorTexto(cuotaInstalacion,'cuotaInstalacion',{ max: 100}),
      errorTexto(hogar,          'hogar',          { max: 100 }),
      errorTexto(tec,            'tec',            { max: 50  }),
      errorTexto(full,           'full',           { max: 50  }),
      errorTexto(plano,          'plano',          { max: 255 }),
      errorTexto(fechaNac,       'fechaNac',       { max: 10  }),
      errorTexto(lugarNac,       'lugarNac',       { max: 150 }),
      errorTexto(padre,          'padre',          { max: 150 }),
      errorTexto(madre,          'madre',          { max: 150 }),
      errorTexto(observacion,    'observacion',    { max: 1000}),
      tipoDoc !== undefined ? errorEnum(tipoDoc, 'tipoDoc', TIPO_DOC_OK) : null,
    ]);
    if (errores) return res.status(400).json({ ok: false, mensaje: errores[0] });

    const venta = await obtenerVentaConAsesor(conn, ventaId);
    if (!venta) return res.status(404).json({ ok: false, mensaje: 'Venta no encontrada.' });

    if (req.user.cargo === 'supervisor') {
      const actor = await obtenerActor(conn, req.user.id);
      if (!supervisorPuedeGestionar(actor, venta))
        return res.status(403).json({ ok: false, mensaje: 'Solo puedes editar ventas de tu sala.' });
    }

    const campos = [], vals = [], cambios = [];
    const agregar = (col, valorNuevo) => {
      if (valorNuevo === undefined) return;
      campos.push(`${col} = ?`);
      vals.push(valorNuevo === '' ? null : valorNuevo);
      if (valorHistorial(venta[col]) !== valorHistorial(valorNuevo === '' ? null : valorNuevo)) {
        cambios.push({ campo: col, valorAnterior: venta[col], valorNuevo: valorNuevo === '' ? null : valorNuevo });
      }
    };
    agregar('nombre',      nombre);
    agregar('tipo_doc',    tipoDoc);
    agregar('dni',         dni);
    agregar('email',       email);
    agregar('telefono1',   telefono1);
    agregar('telefono2',   telefono2);
    agregar('departamento',departamento);
    agregar('provincia',   provincia);
    agregar('distrito',    distrito);
    agregar('direccion',   direccion);
    agregar('coordenadas', coordenadas);
    agregar('paquete',     paquete);
    agregar('cuota_inst',  cuotaInstalacion);
    agregar('claro_hogar', hogar);
    agregar('tecnologia',  tec);
    agregar('full_claro',  full);
    agregar('plano',       plano);
    agregar('fecha_nac',   fechaNac);
    agregar('lugar_nac',   lugarNac);
    agregar('padre',       padre);
    agregar('madre',       madre);
    agregar('cant_decos',  cantDecos !== undefined ? (parseInt(cantDecos) || 0) : undefined);
    agregar('cant_mesh',   cantMesh  !== undefined ? (parseInt(cantMesh)  || 0) : undefined);
    agregar('observacion', observacion);

    if (!campos.length) return res.status(400).json({ ok: false, mensaje: 'Nada que actualizar.' });

    await conn.beginTransaction();
    vals.push(ventaId);
    await conn.query(`UPDATE ventas SET ${campos.join(', ')} WHERE id = ?`, vals);
    const actor = await obtenerActor(conn, req.user.id);
    for (const cambio of cambios) {
      await registrarHistorial(conn, ventaId, actor, { ...cambio, tipo: 'ACTUALIZACION' });
    }
    let leadsSincronizados = 0;
    if (dni !== undefined || tipoDoc !== undefined) {
      leadsSincronizados = await sincronizarDocumentoConBackData(conn, venta, tipoDoc, dni, telefono1);
    }
    await conn.commit();
    res.json({ ok: true, leads_sincronizados:leadsSincronizados, mensaje:'Datos de la venta y Back Data actualizados.' });
  } catch (e) {
    await conn.rollback().catch(() => {});
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar los datos de la venta.' });
  } finally {
    conn.release();
  }
});

// ===== POST /:id/enviar-seguimiento-whatsapp =====
// Envía la plantilla 'seguimiento_agosto' (cuenta SEGUIMIENTO de leads-api) con
// nombre, día/mes de fecha_programada y horario según tramo_seguimiento (AM/PM).
router.post('/:id/enviar-seguimiento-whatsapp', auth(['seguimiento', 'jefatura']), async (req, res) => {
  const ventaId = Number(req.params.id);
  if (!Number.isInteger(ventaId) || ventaId <= 0)
    return res.status(400).json({ ok: false, mensaje: 'ID de venta inválido.' });

  try {
    const [rows] = await db.query(
      `SELECT id, nombre, telefono1, fecha_programada, tramo_seguimiento FROM ventas WHERE id = ? LIMIT 1`,
      [ventaId]
    );
    const venta = rows[0];
    if (!venta) return res.status(404).json({ ok: false, mensaje: 'Venta no encontrada.' });
    if (!venta.telefono1) return res.status(400).json({ ok: false, mensaje: 'La venta no tiene teléfono registrado.' });
    if (!venta.fecha_programada) return res.status(400).json({ ok: false, mensaje: 'La venta no tiene fecha programada.' });

    const tramo = String(venta.tramo_seguimiento || '').trim().toUpperCase();
    const horaTexto = tramo === 'AM' ? '9 AM a 1 PM' : tramo === 'PM' ? '2 PM a 6 PM' : tramo === 'PM 3' ? '6 PM a 8 PM' : null;
    if (!horaTexto) return res.status(400).json({ ok: false, mensaje: 'La venta no tiene tramo de seguimiento (AM/PM) definido.' });

    // No usar new Date(string): "YYYY-MM-DD" se interpreta como medianoche UTC y
    // al convertir a hora de Peru (UTC-5) retrocede un dia. Se extrae directo del texto.
    const partesFecha = String(venta.fecha_programada).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!partesFecha) return res.status(400).json({ ok: false, mensaje: 'Fecha programada inválida.' });
    const dia = `${partesFecha[3]}/${partesFecha[2]}`;

    let data;
    try {
      const resp = await fetch(`${process.env.LEADS_API_URL}/api/interno/enviar-mensaje-personalizado`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.INTERNAL_KRONO_KEY },
        body: JSON.stringify({
          cuenta: 'SEGUIMIENTO',
          telefono: venta.telefono1,
          plantilla: 'seguimiento_agosto',
          valores: { nombre: venta.nombre, dia, hora: horaTexto },
        }),
      });
      data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) {
        return res.status(502).json({ ok: false, mensaje: data.error || 'No se pudo enviar el mensaje de WhatsApp.' });
      }
    } catch (e) {
      console.error('[enviar-seguimiento-whatsapp] Error de conexión con leads-api:', e.message);
      return res.status(502).json({ ok: false, mensaje: 'No se pudo contactar el servicio de WhatsApp.' });
    }

    const actor = await obtenerActor(db, req.user.id);
    await registrarHistorial(db, ventaId, actor, {
      tipo: 'WHATSAPP',
      descripcion: `Mensaje de WhatsApp (seguimiento) enviado a ${venta.telefono1} — horario ${horaTexto}, fecha ${dia}`,
    });

    res.json({ ok: true, mensaje: 'Mensaje de WhatsApp enviado.', whatsapp_message_id: data.whatsapp_message_id || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al enviar el mensaje de WhatsApp.' });
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
