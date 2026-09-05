/* ================================================
   ROUTES/LEADS.JS — MySQL
   ================================================ */
const express = require('express');
const router  = express.Router();
const db      = require('../database');
const auth    = require('../middleware/auth');
const { validar, errorTexto, errorFecha, errorHora, errorHistorial } = require('../middleware/validar');

const ROLES_BO  = ['backoffice','jefatura','usuarios'];
const ROLES_ALL = ['backoffice','jefatura','usuarios','asesor','supervisor','supgrabaciones'];
// Sólo estos estados cierran definitivamente el flujo de asignación/rotación.
const TIPIF_PROHIBIDAS_ASIGNACION = new Set(['VENTA CERRADA', 'NO TOCAR', 'SH NO TOCAR', 'NO ROTAR', 'SH NO ROTAR']);
const CACHE_LISTADO_TTL = 5000;
const cacheListados = new Map();

function cacheListadoGet(clave) {
  const item = cacheListados.get(clave);
  if (!item || item.expira <= Date.now()) { cacheListados.delete(clave); return null; }
  return item.payload;
}

function cacheListadoSet(clave, payload) {
  if (cacheListados.size >= 200) cacheListados.delete(cacheListados.keys().next().value);
  cacheListados.set(clave, { payload, expira: Date.now() + CACHE_LISTADO_TTL });
}

function tipificacionProhibida(valor) {
  return TIPIF_PROHIBIDAS_ASIGNACION.has(String(valor || '').trim().toUpperCase());
}

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

function normalizarUsuarioWhatsapp(valor) {
  return String(valor || '').trim().replace(/^@+/, '').substring(0, 100);
}

function claveIdentidadLead(lead) {
  const numero = normalizarN1(lead?.n1);
  if (numero) return `n1:${numero}`;
  const usuario = normalizarUsuarioWhatsapp(lead?.usuario_whatsapp).toLowerCase();
  return usuario ? `wa:${usuario}` : `id:${lead?.id || ''}`;
}

function normalizarCampana(valor) {
  const campana = String(valor || '')
    .trim()
    .replace(/^CAMP\s+/i, '')
    .trim()
    .substring(0, 100);
  if (campana.replace(/^[—–-]+\s*/, '').toUpperCase() === 'K9') return 'K9';
  return campana;
}

function normalizarFechaAsignacion(valor) {
  const match = String(valor || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function limpiarN2(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Split on '///' to separate phone from GPS data
  const primary = s.includes('///') ? s.split('///')[0].trim() : s;
  const digits = primary.replace(/[^0-9]/g, '');
  // Valid phone: 7–9 digits
  if (digits.length >= 7 && digits.length <= 9) return digits;
  // Peru mobile: 9-digit starting with 9
  const m1 = s.match(/\b9\d{8}\b/);
  if (m1) return m1[0];
  // Any 7–9 digit sequence
  const m2 = s.match(/\b\d{7,9}\b/);
  if (m2) return m2[0];
  return null;
}

function normalizarTipifBack(valor) {
  const tipif = String(valor || '').trim().toUpperCase();
  if (tipif === 'BUZON' || tipif === 'BUZÓN') return 'BUZON DE VOZ';
  if (tipif === 'DER CHAMO') return 'DERIVADO';
  return tipif;
}

function normalizarTipifVendLegacy(valor) {
  const v = String(valor || '').trim();
  const u = v.toUpperCase();
  if (u === 'SH INSTALADO') return 'INSTALADO';
  if (u === 'SH NO ROTAR') return 'NO ROTAR';
  if (u === 'SH NO TOCAR') return 'NO ROTAR';
  return v;
}

function normalizarEstadoCRM(valor) {
  return String(valor || '').trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/_/g, ' ').replace(/\s+/g, ' ');
}

const TIPI_INTERNA_SEGUIMIENTO = new Map([
  ['EN EJECUCION', ['VENTA CERRADA', '#2563eb']],
  ['DERIVADO PLANTA EXTERNA', ['VENTA CERRADA', '#2563eb']],
  ['DERIVADO A PLANTA EXTERNA', ['VENTA CERRADA', '#2563eb']],
  ['LEVANTAR SOT', ['VENTA CERRADA', '#2563eb']],
  ['TECNICOS EN CAMINO', ['VENTA CERRADA', '#2563eb']],
  ['TECNICOS CAMINO', ['VENTA CERRADA', '#2563eb']],
  ['TECNICOS EN CASA', ['VENTA CERRADA', '#2563eb']],
  ['TECNICO CASA', ['VENTA CERRADA', '#2563eb']],
  ['INSTALADO', ['INSTALADO', '#0369a1']],
  ['INSTALADO NO VALIDADO', ['INSTALADO', '#0369a1']],
  ['REASIGNACION', ['INSTALADO', '#0369a1']],
  ['CAIDA', ['VENTA CAIDA', '#a64d79']],
  ['RECHAZO', ['VENTA CAIDA', '#a64d79']],
  ['RECHAZO CAMPO', ['VENTA CAIDA', '#a64d79']],
  ['RECHAZO EN CAMPO', ['VENTA CAIDA', '#a64d79']],
  ['RECHAZO MESA', ['VENTA CAIDA', '#a64d79']],
  ['RECHAZO EN MESA', ['VENTA CAIDA', '#a64d79']],
  ['SERVICIO ACTIVO', ['VENTA CAIDA', '#a64d79']],
]);
const TIPI_INTERNA_VALIDACION = new Map([
  ...['CORTA LLAMADA','BUZON DE VOZ','CORREGIR','FRAUDE','MALA OFERTA','NO CONTESTA','NO DESEA','SERVICIO ACTIVO'].map(v => [v, ['VENTA CAIDA', '#a64d79']]),
  ['VALIDADO', ['VENTA CERRADA', '#2563eb']],
  ['VENTA', ['VENTA CERRADA', '#2563eb']],
]);
const TIPI_INTERNA_GRABACION = new Map([
  ...['PENDIENTE','BUZON DE VOZ','BUZON','CORREGIR SEC','CORTA LLAMADA','ESPERANDO TERCERO','NO CONTESTA','NO DESEA','SUPLANTACION'].map(v => [v, ['VENTA CAIDA', '#a64d79']]),
  ['GRABADO', ['VENTA CERRADA', '#2563eb']],
  ['GRABANDO', ['VENTA CERRADA', '#2563eb']],
]);

function tipificacionInternaVenta(venta) {
  if (!venta) return null;
  const candidatos = [];
  const agregar = (mapa, valor, fecha, area, prioridad, motivo) => {
    const regla = mapa.get(normalizarEstadoCRM(valor));
    if (regla) candidatos.push({
      tipificacion:regla[0], color:regla[1], fecha:fecha || venta.venta_created_at || '',
      area, prioridad, motivo:String(motivo || valor || '').trim()
    });
  };
  const estadoGeneral = normalizarEstadoCRM(venta.estado);
  const estadoValidacion = venta.estado_validacion || (['VENTA','VALIDADO'].includes(estadoGeneral) ? estadoGeneral : '');
  agregar(TIPI_INTERNA_VALIDACION, estadoValidacion, venta.fecha_validacion, 'VALIDACION', 1, estadoValidacion);
  agregar(TIPI_INTERNA_GRABACION, venta.estado_grab, venta.fecha_grabacion, 'GRABACION', 2, venta.estado_grab);
  agregar(TIPI_INTERNA_SEGUIMIENTO, venta.estado, venta.fecha_seguimiento, 'SEGUIMIENTO', 3, venta.motivo_seguimiento || venta.estado);
  candidatos.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || a.prioridad - b.prioridad);
  return candidatos[candidatos.length - 1] || null;
}

function historialArray(valor) {
  if (Array.isArray(valor)) return valor;
  try { return JSON.parse(valor || '[]'); } catch { return []; }
}

function normalizarNombreAsesor(valor) {
  return String(valor || '').trim().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
}

// Devuelve solo asignaciones que no fueron retiradas posteriormente. Un retiro
// deja de tener efecto si el mismo asesor recibe nuevamente el lead después.
function asignacionesVigentesHistorial(valor) {
  const eventos = historialArray(valor);
  const ultimoRetiro = new Map();
  eventos.forEach((h, i) => {
    if (String(h?.tipo || '').trim().toUpperCase() !== 'QUITAR_ASIGNACION') return;
    const nombre = normalizarNombreAsesor(h?.asesorQuitado || h?.asesor_quitado);
    if (nombre) ultimoRetiro.set(nombre, i);
  });
  return eventos.filter((h, i) => {
    const tipo = String(h?.tipo || '').trim().toUpperCase();
    const nombre = normalizarNombreAsesor(h?.asesor);
    return nombre && !['TIPIF_VEND','TIPIF_BACK','DERIVADO','QUITAR_ASIGNACION'].includes(tipo)
      && i > (ultimoRetiro.get(nombre) ?? -1);
  });
}

// Cada asignacion real a un asesor cuenta como una rotacion, incluida la
// asignacion inicial. Se excluyen carga, tipificaciones y eventos auxiliares.
function contarRotacionesHistorial(valor) {
  return historialArray(valor).filter(h => {
    const tipo = String(h?.tipo || '').trim().toUpperCase();
    return Boolean(String(h?.asesor || '').trim())
      && !['CARGA', 'TIPIF_VEND', 'TIPIF_BACK', 'DERIVADO'].includes(tipo);
  }).length;
}

function ultimaTipificacionVendedorHistorial(valor) {
  const eventos = historialArray(valor).filter(h => h?.tipo === 'TIPIF_VEND' && String(h?.tipif || '').trim());
  if (!eventos.length) return '';
  return String(eventos.reduce((a, b) => Number(b.ts || 0) >= Number(a.ts || 0) ? b : a).tipif || '').trim();
}

function esTipificacionOrigen(valor) {
  const tipif = normalizarTipifVendLegacy(valor).trim().toUpperCase();
  return Boolean(tipif) && !['NUEVO', 'NO ROTAR'].includes(tipif);
}

function resumenTipificadoDia(lead, historial, fecha = fechaPeruHoy()) {
  const hist = historialArray(historial);
  const fechaLead = normalizarFechaAsignacion(lead?.fecha);
  const tuvoTipificacion = (esTipificacionOrigen(lead?.tipif_vend) && fechaLead === fecha)
    || hist.some(h => normalizarFechaAsignacion(h?.fecha) === fecha && [h?.tipif, h?.tipif_vend, h?.tipifVendAntes]
      .some(esTipificacionOrigen));
  const rotaciones = hist.filter(h =>
    (String(h?.tipo || '').trim().toUpperCase() === 'ROTACION' || Boolean(h?.reasignadoPor))
    && normalizarFechaAsignacion(h?.fecha) === fecha
  ).length;
  return { aplica: tuvoTipificacion, rotaciones };
}

async function existeTipificadoOtraCampana(conn, n1, fecha, campana, excluirId = null) {
  const params = [normalizarN1(n1), fecha];
  let excluirSql = '';
  if (excluirId) { excluirSql = ' AND id <> ?'; params.push(excluirId); }
  const [rows] = await conn.query(`
    SELECT id, fecha, tipif_vend, historial
    FROM leads
    WHERE n1_normalizado = ?
      AND fecha = ?
      ${excluirSql}
  `, params);
  return rows.some(r => resumenTipificadoDia(r, r.historial, fecha).aplica);
}

// Mismo N1 + misma fecha + MISMA campaña: es un duplicado de carga (error
// del Back). Un N1 repetido en otra campaña el mismo día no cuenta aquí —
// eso es un lead independiente y válido (ver idLeadMasAntiguoDelDia, que sí
// compara entre campañas para la regla operativa de NO ROTAR).
async function existeLeadMismoDiaMismaCampana(conn, n1, fecha, campana, excluirId = null) {
  const numero = normalizarN1(n1);
  if (!numero || !fecha) return null;
  const params = [numero, fecha, normalizarCampana(campana) || '—'];
  let excluirSql = '';
  if (excluirId) { excluirSql = ' AND id <> ?'; params.push(excluirId); }
  const [rows] = await conn.query(`
    SELECT id FROM leads
    WHERE n1_normalizado = ?
      AND fecha = ?
      AND campana = ?
      ${excluirSql}
    LIMIT 1
  `, params);
  return rows[0]?.id || null;
}

async function idLeadMasAntiguoDelDia(conn, n1, fecha) {
  const numero = normalizarN1(n1);
  if (!numero || !fecha) return null;
  const [rows] = await conn.query(`
    SELECT id FROM leads
    WHERE n1_normalizado = ?
      AND fecha = ?
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `, [numero, fecha]);
  return rows[0]?.id || null;
}

// Blacklist: un numero que alguna vez fue tipificado TERNA (en cualquier
// fecha/campana) queda marcado para siempre. Si vuelve a ingresar como lead
// nuevo, se tipifica TERNA automaticamente en vez de entrar como pendiente.
async function huboTernaAlgunaVez(conn, n1) {
  const numero = normalizarN1(n1);
  if (!numero) return false;
  const [rows] = await conn.query(`
    SELECT id FROM leads
    WHERE n1_normalizado = ?
      AND UPPER(TRIM(tipif_vend)) = 'TERNA'
    LIMIT 1
  `, [numero]);
  return rows.length > 0;
}

async function bloquearOtrasCampanasDelDia(conn, lead) {
  const n1 = normalizarN1(lead?.n1);
  const fecha = normalizarFechaAsignacion(lead?.fecha) || fechaPeruHoy();
  if (!n1 || !fecha) return;
  const principalId = await idLeadMasAntiguoDelDia(conn, n1, fecha);
  if (principalId && Number(principalId) !== Number(lead?.id)) {
    await conn.query(`UPDATE leads SET tipif_vend='NO ROTAR', tipif_hora=? WHERE id=?`, [horaPeruAhora(), lead.id]);
    return;
  }
  let creadoEn = lead?.created_at || null;
  if (!creadoEn && lead?.id) {
    const [origen] = await conn.query(`SELECT created_at FROM leads WHERE id=? LIMIT 1`, [lead.id]);
    creadoEn = origen[0]?.created_at || null;
  }
  await conn.query(`
    UPDATE leads
    SET tipif_vend = 'NO ROTAR', tipif_hora = ?
    WHERE id <> ?
      AND n1_normalizado = ?
      AND fecha = ?
      AND UPPER(TRIM(COALESCE(tipif_vend,''))) NOT IN ('VENTA CERRADA','NO TOCAR','SH NO TOCAR','NO ROTAR','SH NO ROTAR')
      AND (? IS NULL OR created_at > ?)
  `, [horaPeruAhora(), principalId || lead.id, n1, fecha, creadoEn, creadoEn]);
}

// Numeros/dia con una rotacion en curso ahora mismo (memoria del proceso).
// Sirve para rechazar de inmediato una segunda rotacion concurrente sobre el
// mismo grupo de duplicados en vez de competir por los mismos locks de fila
// en bloquearDuplicadosAlRotar, que en hora pico terminaba en deadlocks.
const gruposRotandose = new Set();

async function bloquearDuplicadosAlRotar(conn, lead) {
  const n1 = normalizarN1(lead?.n1);
  const fecha = normalizarFechaAsignacion(lead?.fecha);
  if (!n1 || !fecha) return;
  const principalId = await idLeadMasAntiguoDelDia(conn, n1, fecha);
  await conn.query(`
    UPDATE leads SET tipif_vend='NO ROTAR', tipif_hora=?
    WHERE id<>?
      AND n1_normalizado=?
      AND fecha=?
      AND UPPER(TRIM(COALESCE(tipif_vend,''))) NOT IN ('VENTA CERRADA','NO TOCAR','SH NO TOCAR','NO ROTAR','SH NO ROTAR')
  `, [horaPeruAhora(), principalId || lead.id, n1, fecha]);
}

async function nombreUsuario(id) {
  const [rows] = await db.query(`SELECT nombre FROM usuarios WHERE id = ? LIMIT 1`, [id]);
  return rows[0]?.nombre || 'Usuario Back Data';
}

function esCargaAutomaticaPrizma(usuario) {
  return ['sistema-prizma', 'sistema_prizma'].includes(String(usuario || '').trim().toLowerCase());
}

async function obtenerResponsablesBackActivos() {
  const [rows] = await db.query(`
    SELECT id, nombre, usuario
    FROM usuarios
    WHERE cargo = 'backoffice' AND activo = 1
    ORDER BY id
  `);
  return rows;
}

function elegirAleatorio(items) {
  return items.length ? items[Math.floor(Math.random() * items.length)] : null;
}

// GET /api/leads
router.get('/', auth(ROLES_ALL), async (req, res) => {
  try {
    const { fecha, asesor_id, area, numero, desde, hasta } = req.query;
    const permisosUsuario = Array.isArray(req.user.permisos) ? req.user.permisos : [];
    if (area && area !== req.user.cargo && !permisosUsuario.includes(area)) {
      return res.status(403).json({ ok: false, mensaje: 'Sin permiso para consultar esta área' });
    }
    const cargoEfectivo = area || req.user.cargo;
    // La clave siempre incluye la identidad y los permisos efectivos: nunca
    // se comparte información entre usuarios, incluso si tienen igual cargo.
    const cacheClave = `${req.user.id}|${req.user.cargo}|${JSON.stringify(permisosUsuario)}|${req.originalUrl}`;
    const cacheHit = cacheListadoGet(cacheClave);
    if (cacheHit) return res.json(cacheHit);

    const errGet = validar([errorFecha(fecha, 'fecha'), errorFecha(desde, 'desde'), errorFecha(hasta, 'hasta')]);
    if (errGet) return res.status(400).json({ ok: false, mensaje: errGet[0] });
    const busquedaRaw = String(numero || '').trim().slice(0, 100);
    const numeroBusqueda = busquedaRaw.replace(/\D/g, '').slice(0, 20);
    const esBusquedaNumerica = /^[\d\s()+.\-]+$/.test(busquedaRaw);

    // Resolver primero si esta consulta esta acotada a UN asesor (su propia
    // base, o Jefatura viendo la base de un asesor puntual) para poder decidir
    // "este lead ya tiene venta propia/ajena" con un JOIN agregado una sola vez
    // en vez de 2 subconsultas EXISTS/NOT EXISTS correlacionadas por cada lead
    // (con TRIM() en ambos lados, lo que impedia usar cualquier indice). Ese
    // patron era, medido en performance_schema, el mayor consumo de tiempo de
    // BD de todo el sistema: ~230k ejecuciones acumuladas, ~2.5s y >1M filas
    // examinadas por llamada en promedio — causa directa de la saturacion de
    // CPU y de los reinicios por out-of-memory del backend.
    let visorAsesorId = null;
    let visorAsesorNombre = '';
    if (cargoEfectivo === 'asesor') {
      // Base del asesor: leads asignados AHORA a él + los que trabajó antes
      // (su nombre aparece en el historial). Así un número no desaparece de su
      // base al ser rotado a otro asesor; conserva su registro de lo trabajado.
      const [uNom] = await db.query(`SELECT nombre FROM usuarios WHERE id = ? LIMIT 1`, [req.user.id]);
      visorAsesorId = req.user.id;
      visorAsesorNombre = uNom[0]?.nombre || '';
    } else if (asesor_id) {
      const [uNom] = await db.query(`SELECT nombre, cargo FROM usuarios WHERE id = ? LIMIT 1`, [asesor_id]);
      // Jefatura también puede abrir la vista de un usuario de Back Data. Ese
      // usuario administra la base completa y no debe tratarse como asesor
      // asignado, porque hacerlo deja la jornada artificialmente en cero.
      if (String(uNom[0]?.cargo || '').trim().toLowerCase() === 'asesor') {
        visorAsesorId = Number(asesor_id);
        visorAsesorNombre = uNom[0]?.nombre || '';
      }
    }

    // Sin ningun filtro que acote la consulta, esto devuelve la tabla `leads`
    // completa (decenas de miles de filas con su `historial`) en una sola
    // respuesta — se vio en producción una llamada asi devolviendo 7MB en un
    // solo request y tumbando el proceso por out-of-memory. Se exige al menos
    // un criterio real en vez de permitir la descarga completa de la base.
    if (!visorAsesorId && !fecha && !desde && !hasta && !busquedaRaw) {
      return res.status(400).json({ ok: false, mensaje: 'Indica una fecha, un rango de fechas o un criterio de búsqueda para consultar los leads.' });
    }

    // Los contadores se agregan una sola vez y luego se enlazan. Antes eran
    // cinco subconsultas correlacionadas por cada lead (decenas de miles de
    // ejecuciones por petición), principal causa de saturación en hora pico.
    let sql = `SELECT l.*, u.nombre as asesor_nombre_db,
      COALESCE(lc.ciclos_venta, 0) AS ciclos_venta,
      COALESCE(vx.ventas_registradas, 0) AS ventas_registradas,
      ciclo.id AS ciclo_abierto_id,
      ciclo.numero_ciclo AS ciclo_abierto_numero,
      ciclo.tipo AS ciclo_abierto_tipo
      FROM leads l
      LEFT JOIN usuarios u ON l.asesor_id = u.id
      LEFT JOIN (
        SELECT lead_id, COUNT(*) AS ciclos_venta,
               MAX(CASE WHEN estado='ABIERTO' THEN id END) AS ciclo_abierto_id
        FROM lead_ciclos_venta GROUP BY lead_id
      ) lc ON lc.lead_id = l.id
      LEFT JOIN lead_ciclos_venta ciclo ON ciclo.id = lc.ciclo_abierto_id
      LEFT JOIN (
        SELECT TRIM(telefono1) AS telefono1, COUNT(*) AS ventas_registradas
        FROM ventas WHERE telefono1 IS NOT NULL AND TRIM(telefono1)<>''
        GROUP BY TRIM(telefono1)
      ) vx ON vx.telefono1 = TRIM(l.n1)`;
    const params = [];
    if (visorAsesorId) {
      // Mismo patron que `vx`: agrega una sola vez, ya filtrado por el asesor
      // (indice por asesor_id), si el numero tiene alguna venta propia —
      // reemplaza el EXISTS(...AND v.asesor_id=?) correlacionado de mas abajo.
      sql += ` LEFT JOIN (
        SELECT TRIM(telefono1) AS telefono1
        FROM ventas WHERE asesor_id = ? AND telefono1 IS NOT NULL AND TRIM(telefono1)<>''
        GROUP BY TRIM(telefono1)
      ) vxa ON vxa.telefono1 = TRIM(l.n1)`;
      params.push(visorAsesorId);
    }
    sql += ` WHERE 1=1`;
    // Las instancias técnicas representan formularios independientes para el
    // asesor; Back Data conserva una sola fila para el cliente principal.
    if (cargoEfectivo !== 'asesor' && !asesor_id) sql += ` AND l.lead_origen_id IS NULL`;

    // La búsqueda global se resuelve en MySQL y no descargando toda la base al
    // navegador. Para teléfonos completos conserva búsquedas indexables.
    if (busquedaRaw && esBusquedaNumerica && numeroBusqueda) {
      if (numeroBusqueda.length >= 7) {
        sql += ` AND (l.n1 = ? OR l.n2 = ?)`;
        params.push(numeroBusqueda, numeroBusqueda);
      } else {
        sql += ` AND (l.n1 LIKE ? OR l.n2 LIKE ?)`;
        params.push(`%${numeroBusqueda}%`, `%${numeroBusqueda}%`);
      }
    } else if (busquedaRaw) {
      sql += ` AND l.usuario_whatsapp LIKE ?`;
      params.push(`%${normalizarUsuarioWhatsapp(busquedaRaw)}%`);
    }
    if (desde) { sql += ` AND l.fecha >= ?`; params.push(desde); }
    if (hasta) { sql += ` AND l.fecha <= ?`; params.push(hasta); }

    if (visorAsesorId) {
      // El nombre debe figurar como ASESOR titular de alguna asignación ("asesor":"nom"),
      // no como asesorAnterior/rotadoPor. Así, al quitar su asignación desaparece de su base.
      sql += ` AND (l.asesor_id = ? OR l.historial LIKE CONCAT('%\"asesor\":\"', ?, '\"%'))`;
      params.push(visorAsesorId, visorAsesorNombre);
      // Si el número ya produjo una venta, queda visible para quien la registró
      // o para el titular actual. Esto permite que una VENTA CAIDA rotada llegue
      // como NUEVO al vendedor que debe intentar cerrarla nuevamente.
      sql += ` AND (
        l.asesor_id = ?
        OR COALESCE(vx.ventas_registradas, 0) = 0
        OR vxa.telefono1 IS NOT NULL
      )`;
      params.push(visorAsesorId);
    }

    // Sin visor de asesor la fecha representa la base original. Para la base
    // individual representa el dia en que el asesor recibio el numero. Esta
    // preseleccion reduce la respuesta y el filtro exacto se realiza mas abajo.
    if (fecha && !visorAsesorId) {
      sql += ` AND l.fecha = ?`;
      params.push(fecha);
    } else if (fecha && visorAsesorId) {
      sql += ` AND (l.fecha = ? OR l.historial LIKE ?)`;
      params.push(fecha, `%"fecha":"${fecha}%`);
    }
    sql += ` ORDER BY l.created_at DESC`;

    const [data] = await db.query(sql, params);

    // Segunda query: datos de ventas para todos los teléfonos en un solo round-trip.
    // Reemplaza las 3 subqueries correlacionadas que antes se ejecutaban una vez por fila.
    let ventaMap = new Map(); // TRIM(telefono1) -> { venta_asesor_id, venta_asesor_nombre }
    const sinCoberturaPorNumero = new Map();
    const sinCoberturaPorUsuario = new Map();
    if (data.length > 0) {
      const phones = [...new Set(data.map(l => (l.n1 || '').trim()).filter(Boolean))];
      const usuariosWhatsapp = [...new Set(data
        .map(l => normalizarUsuarioWhatsapp(l.usuario_whatsapp).toLowerCase())
        .filter(Boolean))];
      if (phones.length > 0 || usuariosWhatsapp.length > 0) {
        const condicionesCobertura = [];
        const paramsCobertura = [];
        if (phones.length > 0) {
          condicionesCobertura.push(`TRIM(n1) IN (${phones.map(() => '?').join(',')})`);
          paramsCobertura.push(...phones);
        }
        if (usuariosWhatsapp.length > 0) {
          condicionesCobertura.push(`LOWER(TRIM(REPLACE(usuario_whatsapp,'@',''))) IN (${usuariosWhatsapp.map(() => '?').join(',')})`);
          paramsCobertura.push(...usuariosWhatsapp);
        }
        const [antecedentesCobertura] = await db.query(
          `SELECT id, n1, usuario_whatsapp, distrito_sin_cobertura, coordenadas_sin_cobertura
             FROM leads
            WHERE UPPER(TRIM(COALESCE(tipif_vend,'')))='SIN COBERTURA'
              AND (${condicionesCobertura.join(' OR ')})
            ORDER BY id DESC`,
          paramsCobertura
        );
        for (const antecedente of antecedentesCobertura) {
          const numero = normalizarN1(antecedente.n1);
          const usuario = normalizarUsuarioWhatsapp(antecedente.usuario_whatsapp).toLowerCase();
          if (numero && !sinCoberturaPorNumero.has(numero)) sinCoberturaPorNumero.set(numero, antecedente);
          if (usuario && !sinCoberturaPorUsuario.has(usuario)) sinCoberturaPorUsuario.set(usuario, antecedente);
        }
      }
      if (phones.length > 0) {
        const placeholders = phones.map(() => '?').join(',');
        const [ventas] = await db.query(
          `SELECT v.id, v.telefono1, v.asesor_id, u.nombre AS asesor_nombre,
                  v.dni AS venta_documento, v.tipo_doc AS venta_tipo_doc,
                  v.estado, v.estado_grab, v.motivo_seguimiento, v.created_at AS venta_created_at, v.canal
             FROM ventas v LEFT JOIN usuarios u ON u.id = v.asesor_id
            WHERE v.telefono1 IN (${placeholders})
              AND v.id = (SELECT MAX(v2.id) FROM ventas v2 WHERE v2.telefono1 = v.telefono1)`,
          phones
        );
        if (ventas.length) {
          const ventaIds = ventas.map(v => v.id);
          const idsSql = ventaIds.map(() => '?').join(',');
          const [eventos] = await db.query(
            `SELECT venta_id,
                    SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN campo='estado' AND tipo='CAMBIO_VALIDACION' THEN valor_nuevo END ORDER BY id DESC SEPARATOR '|||'), '|||', 1) AS estado_validacion,
                    MAX(CASE WHEN campo='estado' AND tipo='CAMBIO_VALIDACION' THEN created_at END) AS fecha_validacion,
                    MAX(CASE WHEN campo='estado_grab' THEN created_at END) AS fecha_grabacion,
                    MAX(CASE WHEN modulo='Seguimiento' AND campo IN ('estado','motivo_seguimiento','tramo_seguimiento') THEN created_at END) AS fecha_seguimiento
               FROM venta_historial
              WHERE venta_id IN (${idsSql}) GROUP BY venta_id`,
            ventaIds
          );
          const eventosMap = new Map(eventos.map(e => [Number(e.venta_id), e]));
          for (const venta of ventas) Object.assign(venta, eventosMap.get(Number(venta.id)) || {});
        }
        for (const vv of ventas) {
          ventaMap.set((vv.telefono1 || '').trim(), { ...vv, venta_asesor_id: vv.asesor_id, venta_asesor_nombre: vv.asesor_nombre });
        }
      }
    }

    const resumenNumeroDia = new Map();
    for (const l of data) {
      const clave = `${claveIdentidadLead(l)}|${normalizarFechaAsignacion(l.fecha)}`;
      const rotaciones = contarRotacionesHistorial(l.historial);
      const actual = resumenNumeroDia.get(clave);
      const maxRotaciones = Math.max(Number(actual?.rotaciones || 0), rotaciones);
      if (!actual || String(l.created_at || '').localeCompare(String(actual.createdAt || '')) < 0 ||
          (String(l.created_at || '') === String(actual.createdAt || '') && Number(l.id) < Number(actual.id))) {
        resumenNumeroDia.set(clave, { id:Number(l.id), createdAt:l.created_at, rotaciones:maxRotaciones });
      } else {
        actual.rotaciones = maxRotaciones;
      }
    }

    const salida = data.map(l => {
      const historial = (() => { try { return JSON.parse(l.historial||'[]'); } catch(e){ return []; } })();
      const claveNumeroDia = `${claveIdentidadLead(l)}|${normalizarFechaAsignacion(l.fecha)}`;
      const resumenDia = resumenNumeroDia.get(claveNumeroDia);
      const rotacionesReales = Number(resumenDia?.rotaciones || contarRotacionesHistorial(historial));
      const esPrincipalDia = Number(resumenDia?.id) === Number(l.id);
      const tipifPersistida = normalizarTipifVendLegacy(l.tipif_vend);
      const antecedenteSinCobertura = sinCoberturaPorNumero.get(normalizarN1(l.n1))
        || sinCoberturaPorUsuario.get(normalizarUsuarioWhatsapp(l.usuario_whatsapp).toLowerCase())
        || null;
      const alertaSinCobertura = Boolean(
        antecedenteSinCobertura
        && Number(antecedenteSinCobertura.id) !== Number(l.id)
        && String(tipifPersistida || '').trim().toUpperCase() !== 'SIN COBERTURA'
      );
      const tipifVisible = esPrincipalDia && String(tipifPersistida).toUpperCase() === 'NO ROTAR'
        ? (ultimaTipificacionVendedorHistorial(historial) || tipifPersistida)
        : tipifPersistida;
      let obsAsesor = l.obs_asesor || '';
      const documentoEnObs = obsAsesor.match(/\b(DNI|CE|RUC)\s*:\s*\d+/i)?.[0] || '';
      if (visorAsesorId && visorAsesorNombre && documentoEnObs) {
        const preventas = historial.filter(h => h?.tipo === 'TIPIF_VEND' && String(h?.tipif || '').trim().toUpperCase() === 'PREVENTA');
        const ultimaPreventa = preventas[preventas.length - 1];
        if (ultimaPreventa) {
          obsAsesor = String(ultimaPreventa.asesor || '').trim() === visorAsesorNombre.trim()
            ? (ultimaPreventa.documento || documentoEnObs)
            : obsAsesor.replace(documentoEnObs, '').replace(/^\s*\|\s*|\s*\|\s*$/g, '').trim();
        }
      }
      const ventaInfo = ventaMap.get((l.n1 || '').trim());
      const ventaConfirmada = ventaInfo ? 1 : 0;
      const ventaAsesorId = ventaInfo?.venta_asesor_id ?? null;
      const ventaAsesorNombre = ventaInfo?.venta_asesor_nombre ?? null;
      const tipifInterna = tipificacionInternaVenta(ventaInfo);
      // Una venta caída vuelve a pertenecer al lead y puede ser rotada a otro
      // vendedor. Las ventas vigentes continúan proyectando al vendedor de venta.
      const cicloAbierto = Number(l.ciclo_abierto_id || 0) > 0;
      // El asesor necesita ver el ciclo nuevo como pendiente para poder
      // tipificarlo. Back Data conserva el estado comercial cerrado del lead.
      const cicloAbiertoParaAsesor = cicloAbierto && Boolean(visorAsesorId);
      const ventaCerrada = !cicloAbierto && ventaConfirmada === 1 && ventaAsesorId && tipifInterna?.tipificacion !== 'VENTA CAIDA';
      let obsAsesorPersonal = obsAsesor;
      let obsBackPersonal = l.obs_back || '';
      if (visorAsesorId && visorAsesorNombre) {
        const esTitularVista = Number(l.asesor_id) === Number(visorAsesorId)
          || String(l.asesor_nombre || '').trim() === visorAsesorNombre.trim();
        if (esTitularVista) {
          const asignacionesVista = historial.filter(h =>
            h?.asesor && !['TIPIF_VEND','TIPIF_BACK','DERIVADO'].includes(String(h.tipo || '').toUpperCase())
            && String(h.asesor).trim() === visorAsesorNombre.trim()
          );
          const asignacionVista = asignacionesVista[asignacionesVista.length - 1];
          // Compatibilidad con tipificaciones guardadas antes de separar los eventos
          // de Back de las asignaciones: recupera el valor personal más reciente.
          const eventoBackVista = [...historial].reverse().find(h =>
            h?.obsBackPersonal != null
            && String(h.asesor || '').trim() === visorAsesorNombre.trim()
          );
          obsAsesorPersonal = asignacionVista?.obsAsesorPersonal ?? obsAsesor;
          obsBackPersonal = asignacionVista?.obsBackPersonal ?? eventoBackVista?.obsBackPersonal ?? '';
        } else {
          const rotacionVista = [...historial].reverse().find(h =>
            String(h?.asesorAnterior || '').trim() === visorAsesorNombre.trim()
          );
          obsAsesorPersonal = rotacionVista?.obsAsesorAntes || '';
          obsBackPersonal = rotacionVista?.obsBackAntes || '';
        }
      }
      return {
        ...l,
        campana: normalizarCampana(l.campana) || l.campana,
        tipif_vend: tipifVisible,
        rotaciones: rotacionesReales,
        venta_confirmada: cicloAbiertoParaAsesor ? 0 : ventaConfirmada,
        venta_asesor_id: ventaAsesorId,
        venta_asesor_nombre: ventaAsesorNombre,
        venta_documento: ventaInfo?.venta_documento || '',
        venta_tipo_doc: ventaInfo?.venta_tipo_doc || '',
        venta_canal: ventaInfo?.canal || '',
        tipif_interna: cicloAbiertoParaAsesor ? '' : (tipifInterna?.tipificacion || ''),
        tipif_interna_color: cicloAbiertoParaAsesor ? '' : (tipifInterna?.color || ''),
        tipif_interna_area: cicloAbiertoParaAsesor ? '' : (tipifInterna?.area || ''),
        tipif_interna_fecha: cicloAbiertoParaAsesor ? '' : (tipifInterna?.fecha || ''),
        tipif_interna_motivo: cicloAbiertoParaAsesor ? '' : (tipifInterna?.motivo || ''),
        alerta_sin_cobertura: alertaSinCobertura ? 1 : 0,
        alerta_sin_cobertura_distrito: alertaSinCobertura ? (antecedenteSinCobertura.distrito_sin_cobertura || '') : '',
        alerta_sin_cobertura_coordenadas: alertaSinCobertura ? (antecedenteSinCobertura.coordenadas_sin_cobertura || '') : '',
        ...(ventaCerrada ? { asesor_id: ventaAsesorId, asesor_nombre: ventaAsesorNombre || l.asesor_nombre, sin_asignar:0, tipif_vend:'VENTA CERRADA' } : {}),
        obs_asesor: obsAsesor,
        obs_asesor_personal: obsAsesorPersonal,
        obs_back_personal: obsBackPersonal,
        historial,
      };
    });
    // Por numero y dia, solo la caida mas antigua conserva tipificacion. Todas
    // las posteriores se proyectan como NO ROTAR y comparten su contador.
    const gruposPorDia = new Map();
    for (const lead of salida) {
      if (lead.lead_origen_id) continue;
      const clave = `${claveIdentidadLead(lead)}|${normalizarFechaAsignacion(lead.fecha)}`;
      if (!gruposPorDia.has(clave)) gruposPorDia.set(clave, []);
      gruposPorDia.get(clave).push(lead);
    }
    for (const grupo of gruposPorDia.values()) {
      if (grupo.length < 2) continue;
      grupo.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || Number(a.id) - Number(b.id));
      const principal = grupo[0];
      // Si una version anterior marco por error tambien al principal como
      // NO ROTAR, recupera su ultima tipificacion real desde el historial.
      if (normalizarTipifVendLegacy(principal.tipif_vend).trim().toUpperCase() === 'NO ROTAR') {
        const eventosValidos = historialArray(principal.historial).filter(h =>
          String(h?.tipo || '').trim().toUpperCase() === 'TIPIF_VEND'
          && esTipificacionOrigen(h?.tipif)
        );
        if (eventosValidos.length) {
          eventosValidos.sort((a, b) => Number(a?.ts || 0) - Number(b?.ts || 0));
          principal.tipif_vend = normalizarTipifVendLegacy(eventosValidos[eventosValidos.length - 1].tipif);
        }
      }
      for (const duplicado of grupo.slice(1)) {
        // TERNA (blacklist) es permanente: no debe ocultarse detras de la
        // proyeccion NO ROTAR de duplicados del mismo numero+dia.
        if (String(duplicado.tipif_vend || '').trim().toUpperCase() === 'TERNA') continue;
        duplicado.tipif_vend = 'NO ROTAR';
        duplicado.rotaciones = principal.rotaciones;
      }
    }
    const dataFiltrada = fecha && visorAsesorId
      ? salida.filter(l => {
          // Para la base diaria se toma solamente la ultima asignacion
          // correspondiente al asesor consultado. Ser el titular actual no
          // arrastra automaticamente asignaciones de dias anteriores.
          const asignaciones = l.historial.filter(h =>
            h?.fecha && h?.asesor && h.tipo !== 'TIPIF_VEND' &&
            (!visorAsesorNombre || String(h.asesor).trim() === visorAsesorNombre.trim())
          );
          const ultimaAsignacion = asignaciones[asignaciones.length - 1];
          return normalizarFechaAsignacion(ultimaAsignacion?.fecha || l.fecha) === fecha;
        })
      : salida;
    const payload = { ok: true, data: dataFiltrada };
    cacheListadoSet(cacheClave, payload);
    res.json(payload);
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener leads' });
  }
});

// Fechas disponibles para navegar la base sin descargar todos los leads.
router.get('/fechas', auth(ROLES_ALL), async (_req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, COUNT(*) AS cantidad
      FROM leads
      GROUP BY fecha
      ORDER BY fecha DESC
    `);
    res.json({ ok:true, data:rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, mensaje:'Error al obtener fechas de leads' });
  }
});

// GET /api/leads/ventas-cerradas
// Retorna los números del asesor autenticado con tipif_vend = 'VENTA CERRADA' para hoy (Perú).
router.get('/ventas-cerradas', auth(['asesor', 'jefatura', 'usuarios']), async (req, res) => {
  try {
    const hoy = fechaPeruHoy();
    const [rows] = await db.query(
      `SELECT id, n1, fecha, historial FROM leads
       WHERE asesor_id = ? AND UPPER(tipif_vend) = 'VENTA CERRADA'
       AND (
         n1 NOT IN (SELECT COALESCE(TRIM(telefono1),'') FROM ventas WHERE telefono1 IS NOT NULL AND TRIM(telefono1) != '')
         OR EXISTS (SELECT 1 FROM lead_ciclos_venta lcv WHERE lcv.lead_id=leads.id AND lcv.estado='ABIERTO')
       )`,
      [req.user.id]
    );
    const data = [];
    for (const l of rows) {
      try {
        const hist = JSON.parse(l.historial || '[]');
        const asignaciones = hist.filter(h => h?.fecha && h?.asesor);
        const ultima = asignaciones[asignaciones.length - 1];
        const fechaEntry = ultima?.fecha
          ? String(ultima.fecha).match(/^(\d{4}-\d{2}-\d{2})/)?.[1]
          : String(l.fecha || '').match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
        if (fechaEntry === hoy) data.push({ n1: l.n1 });
      } catch(e) { /* skip */ }
    }
    res.json({ ok: true, data });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener ventas cerradas del día' });
  }
});

// GET /api/leads/marketing-resumen
// Resumen agregado para trasladar resultados a Marketing — Jefatura ve todo
// el panel, y el cargo 'marketing' tiene acceso acotado solo a este reporte
// (su propia página, /marketing-leads, sin el resto de Jefatura).
router.get('/marketing-resumen', auth(['jefatura','marketing']), async (req, res) => {
  try {
    const desde = String(req.query.desde || '').trim();
    const hasta = String(req.query.hasta || '').trim();
    const campana = String(req.query.campana || '').trim();
    const tipificacion = String(req.query.tipificacion || '').trim();
    const errores = validar([
      errorFecha(desde || undefined, 'desde'),
      errorFecha(hasta || undefined, 'hasta'),
      errorTexto(campana, 'campana', { max:100 }),
      errorTexto(tipificacion, 'tipificacion', { max:100 }),
    ]);
    if (errores) return res.status(400).json({ ok:false, mensaje:errores[0] });
    if (desde && hasta && desde > hasta)
      return res.status(400).json({ ok:false, mensaje:'La fecha Desde no puede ser posterior a Hasta' });

    const campanaSql = `COALESCE(NULLIF(TRIM(CASE WHEN UPPER(TRIM(l.campana)) IN ('—K9','–K9','-K9') THEN 'K9' WHEN UPPER(TRIM(l.campana)) LIKE 'CAMP %' THEN SUBSTRING(TRIM(l.campana), 6) ELSE TRIM(l.campana) END),''), 'SIN CAMPAÑA')`;
    const condiciones = [];
    const params = [];
    // Por `fecha` (día de trabajo real), no por created_at (cuándo se cargó en
    // la BD) — deben coincidir con lo que Backoffice cuenta como "Fecha activa"
    // para la misma fecha. Ver también leads-reclutamiento.js, que ya usaba
    // l.fecha correctamente en su propio marketing-resumen.
    if (desde) { condiciones.push('l.fecha >= ?'); params.push(desde); }
    if (hasta) { condiciones.push('l.fecha <= ?'); params.push(hasta); }
    if (campana) { condiciones.push(`${campanaSql} = ?`); params.push(normalizarCampana(campana) || campana); }
    const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

    const [leadsRows] = await db.query(`
      SELECT l.n1, ${campanaSql} AS campana, l.tipif_vend, l.tipif_back_2, l.tipif_back, l.created_at
      FROM leads l
      ${where}
    `, params);

    // leads.tipif_vend se congela en 'VENTA CERRADA' al cerrar la venta y JAMÁS
    // se actualiza después — el estado real (INSTALADO, CAIDA, y sus variantes
    // como REASIGNACION/RECHAZO_MESA/SERVICIO_ACTIVO) vive en `ventas`, ajeno
    // a `leads`. En vez de reinventar ese mapeo en SQL (fácil de dejar casos
    // afuera), se reutiliza tipificacionInternaVenta() — la misma función que
    // ya usa GET /leads para la columna/filtro "INSTALADO" de Backoffice —
    // junto con el mismo criterio de esa vista: la venta más reciente por
    // TELÉFONO (no por lead_id — un mismo número puede repetirse en varias
    // filas/campañas y todas comparten el estado real de esa venta).
    let ventaMap = new Map();
    if (leadsRows.length) {
      const phones = [...new Set(leadsRows.map(l => (l.n1 || '').trim()).filter(Boolean))];
      if (phones.length) {
        const placeholders = phones.map(() => '?').join(',');
        const [ventas] = await db.query(
          `SELECT v.id, v.telefono1, v.estado, v.estado_grab, v.motivo_seguimiento, v.created_at AS venta_created_at
             FROM ventas v
            WHERE v.telefono1 IN (${placeholders})
              AND v.id = (SELECT MAX(v2.id) FROM ventas v2 WHERE v2.telefono1 = v.telefono1)`,
          phones
        );
        if (ventas.length) {
          const ventaIds = ventas.map(v => v.id);
          const idsSql = ventaIds.map(() => '?').join(',');
          const [eventos] = await db.query(
            `SELECT venta_id,
                    SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN campo='estado' AND tipo='CAMBIO_VALIDACION' THEN valor_nuevo END ORDER BY id DESC SEPARATOR '|||'), '|||', 1) AS estado_validacion,
                    MAX(CASE WHEN campo='estado' AND tipo='CAMBIO_VALIDACION' THEN created_at END) AS fecha_validacion,
                    MAX(CASE WHEN campo='estado_grab' THEN created_at END) AS fecha_grabacion,
                    MAX(CASE WHEN modulo='Seguimiento' AND campo IN ('estado','motivo_seguimiento','tramo_seguimiento') THEN created_at END) AS fecha_seguimiento
               FROM venta_historial
              WHERE venta_id IN (${idsSql}) GROUP BY venta_id`,
            ventaIds
          );
          const eventosMap = new Map(eventos.map(e => [Number(e.venta_id), e]));
          for (const venta of ventas) Object.assign(venta, eventosMap.get(Number(venta.id)) || {});
        }
        for (const vv of ventas) ventaMap.set((vv.telefono1 || '').trim(), vv);
      }
    }

    const resumenMap = new Map();
    const campanasSet = new Set();
    const tipificacionesSet = new Set(['INSTALADO', 'VENTA CAIDA']);
    for (const l of leadsRows) {
      const ventaInfo = ventaMap.get((l.n1 || '').trim());
      const tipifInterna = tipificacionInternaVenta(ventaInfo);
      const tipificacionFila = tipifInterna?.tipificacion
        || [l.tipif_vend, l.tipif_back_2, l.tipif_back].map(v => String(v || '').trim()).find(Boolean)
        || 'SIN TIPIFICAR';
      campanasSet.add(l.campana);
      tipificacionesSet.add(tipificacionFila);
      if (tipificacion && tipificacionFila !== tipificacion) continue;
      const clave = `${l.campana}|||${tipificacionFila}`;
      const actual = resumenMap.get(clave) || { campana: l.campana, tipificacion: tipificacionFila, cantidad: 0, primera_alta: l.created_at, ultima_alta: l.created_at };
      actual.cantidad++;
      if (String(l.created_at) < String(actual.primera_alta)) actual.primera_alta = l.created_at;
      if (String(l.created_at) > String(actual.ultima_alta)) actual.ultima_alta = l.created_at;
      resumenMap.set(clave, actual);
    }
    const filas = [...resumenMap.values()].sort((a, b) =>
      b.cantidad - a.cantidad || a.campana.localeCompare(b.campana) || a.tipificacion.localeCompare(b.tipificacion));

    const [campanasTodas] = await db.query(`SELECT DISTINCT ${campanaSql} campana FROM leads l ORDER BY campana`);
    res.json({
      ok:true,
      data:filas,
      filtros:{
        campanas:campanasTodas.map(f => f.campana),
        tipificaciones:[...tipificacionesSet].sort(),
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, mensaje:'Error al generar el dashboard de Marketing' });
  }
});

// GET /api/leads/avance-asesor — fotografía histórica propia de cada vendedor.
// Una rotación posterior nunca cambia la tipificación/observación de esta vista.
router.get('/avance-asesor', auth(ROLES_BO), async (req, res) => {
  try {
    const asesorId = Number(req.query.asesor_id);
    const fecha = String(req.query.fecha || '').trim();
    const errores = validar([errorFecha(fecha, 'fecha')]);
    if (!asesorId || errores) return res.status(400).json({ ok:false, mensaje:errores?.[0] || 'Asesor inválido' });
    const [usuarios] = await db.query(`SELECT nombre FROM usuarios WHERE id=? LIMIT 1`, [asesorId]);
    if (!usuarios.length) return res.status(404).json({ ok:false, mensaje:'Asesor no encontrado' });
    const nombre = String(usuarios[0].nombre || '').trim();
    const [leads] = await db.query(`
      SELECT id,n1,n2,distrito,campana,asesor_id,asesor_nombre,DATE_FORMAT(fecha,'%Y-%m-%d') AS fecha,hora_asig,tipif_vend,tipif_hora,obs_asesor,historial
      FROM leads
      WHERE (asesor_id=? OR historial LIKE CONCAT('%"asesor":"', ?, '"%'))
        AND (fecha=? OR historial LIKE ?)
      ORDER BY created_at DESC
    `, [asesorId, nombre, fecha, `%"fecha":"${fecha}"%`]);

    const data = [];
    for (const lead of leads) {
      let historial = [];
      try { historial = JSON.parse(lead.historial || '[]'); } catch { historial = []; }
      const asignaciones = historial.filter(h => h?.asesor && h?.fecha === fecha && String(h.asesor).trim() === nombre && h.tipo !== 'TIPIF_VEND');
      const asignacion = asignaciones[asignaciones.length - 1];
      const esTitularEnFecha = lead.fecha === fecha && Number(lead.asesor_id) === asesorId;
      if (!asignacion && !esTitularEnFecha) continue;

      const eventos = historial.filter(h => h?.tipo === 'TIPIF_VEND' && String(h.asesor || '').trim() === nombre && h.fecha === fecha);
      const evento = eventos[eventos.length - 1];
      const rotacion = [...historial].reverse().find(h => String(h?.asesorAnterior || '').trim() === nombre && (!h.fecha || h.fecha === fecha));
      const tipificacion = evento?.tipif ?? rotacion?.tipifVendAntes ?? (esTitularEnFecha ? lead.tipif_vend : '') ?? '';
      const observacion = asignacion?.obsAsesorPersonal ?? rotacion?.obsAsesorAntes ?? (esTitularEnFecha ? lead.obs_asesor : '') ?? '';
      const obsBack = asignacion?.obsBackPersonal ?? rotacion?.obsBackAntes ?? '';
      data.push({
        id:lead.id, n1:lead.n1, n2:lead.n2, distrito:lead.distrito, campana:normalizarCampana(lead.campana) || lead.campana,
        hora_asig:asignacion?.hora || (esTitularEnFecha ? lead.hora_asig : '') || '',
        tipif_vend:tipificacion,
        tipif_hora:evento?.hora || (esTitularEnFecha ? lead.tipif_hora : '') || '',
        obs_asesor:observacion,
        obs_back:obsBack,
      });
    }
    data.sort((a,b) => Number(Boolean(a.tipif_vend)) - Number(Boolean(b.tipif_vend)) || String(b.hora_asig).localeCompare(String(a.hora_asig)));
    res.json({ ok:true, data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, mensaje:'Error al obtener el avance del asesor' });
  }
});

// POST /api/leads/import-legacy
// Importacion masiva con historial completo (ASESOR 1-6), tipif_vend, idempotente y transaccional.
router.post('/import-legacy', auth(ROLES_BO), async (req, res) => {
  const conn = await db.getConnection();
  try {
    // Soporta dos formatos de body:
    //  - Array de registros (formato original, idempotente por n1+fecha)
    //  - { registros: [...], permitirDuplicados: true } para permitir duplicados dentro de la carga
    const permitirDuplicados = (!Array.isArray(req.body) && req.body && req.body.permitirDuplicados === true);
    const registros = Array.isArray(req.body)
      ? req.body
      : (Array.isArray(req.body && req.body.registros) ? req.body.registros : [req.body]);
    if (!registros.length)
      return res.status(400).json({ ok: false, mensaje: 'No se recibieron registros' });

    let creados = 0, actualizados = 0, existentes = 0, errores = 0;
    const erroresDetalle = [];
    const bloqueadosTernaImport = [];
    const cargadoPorImport = await nombreUsuario(req.user.id);
    const ipCarga = req.ip || req.socket?.remoteAddress || '';

    await conn.beginTransaction();

    for (let idx = 0; idx < registros.length; idx++) {
      const l = registros[idx];
      try {
        // Validar y normalizar n1 (solo dígitos, sin espacios)
        const n1Raw = normalizarN1(l.n1);
        if (!n1Raw || n1Raw.length < 6) {
          errores++;
          erroresDetalle.push({ fila: idx + 1, n1: l.n1, motivo: 'N1 vacío o inválido' });
          continue;
        }

        // Limpiar n2: extrae número de teléfono válido, descarta GPS y texto
        const n2Clean = limpiarN2(l.n2);

        const fechaLead  = String(l.fecha || fechaPeruHoy()).substring(0, 10);
        const campana    = normalizarCampana(l.campana);
        const distrito   = String(l.distrito   || '').substring(0, 100);
        const tipifBack  = normalizarTipifBack(l.tipif_back);
        let tipifVend  = normalizarTipifVendLegacy(l.tipif_vend).substring(0, 100);
        if (await existeTipificadoOtraCampana(conn, n1Raw, fechaLead, campana)) tipifVend = 'NO ROTAR';
        const enBlacklistImport = await huboTernaAlgunaVez(conn, n1Raw);
        if (enBlacklistImport) tipifVend = 'TERNA';
        const hora       = String(l.hora       || '').trim().substring(0, 10);
        const obsAsesor  = String(l.comentario || '').trim().substring(0, 2000) || null;

        // Construir historial desde array de asesores
        const asesores = Array.isArray(l.asesores)
          ? l.asesores.map(a => String(a || '').trim()).filter(a => a.length > 1)
          : [];
        const lastAsesor = asesores.length ? asesores[asesores.length - 1] : '';

        const historialArray = asesores.length > 0
          ? asesores.map((a, i) => ({
              asesor:         a,
              asesorAnterior: i > 0 ? asesores[i - 1] : '',
              tipo:           i > 0 ? 'ROTACION' : '',
              hora:           i === asesores.length - 1 ? hora : '',
              fecha:          fechaLead,
              motivo:         i === 0 ? 'Asignacion importada' : 'Rotacion importada',
              tipif_vend:     i === asesores.length - 1 ? tipifVend : '',
              importado:      true,
              ...(i === 0 ? { cargadoPor: cargadoPorImport } : {}),
            }))
          : [{ tipo: 'CARGA', cargadoPor: cargadoPorImport, fecha: fechaLead, motivo: 'Importacion masiva' }];

        // Buscar asesor en usuarios (case insensitive)
        let asesorId = null, asesorNombre = '';
        if (lastAsesor) {
          const [uRows] = await conn.query(
            `SELECT id, nombre FROM usuarios WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?)) LIMIT 1`,
            [lastAsesor]
          );
          if (uRows.length) { asesorId = uRows[0].id; asesorNombre = uRows[0].nombre; }
          else               { asesorNombre = lastAsesor; }
        }

        const rotaciones = Math.max(0, asesores.length - 1);
        const sinAsignar = asesorId ? 0 : 1;

        // Verificar si n1 + fecha ya existe (clave de idempotencia).
        // Con permitirDuplicados=true se omite el chequeo y se inserta siempre,
        // permitiendo duplicados del mismo número dentro de la misma carga/fecha.
        let existing = [];
        if (!permitirDuplicados) {
          [existing] = await conn.query(
            `SELECT id, historial, obs_asesor FROM leads WHERE n1 = ? AND fecha = ? LIMIT 1`,
            [n1Raw, fechaLead]
          );
        }

        if (existing.length) {
          const existingHist = (() => { try { return JSON.parse(existing[0].historial || '[]'); } catch(e) { return []; } })();
          const existingObs  = existing[0].obs_asesor || null;
          if (existingHist.length === 0 && historialArray.length > 0) {
            // Historial vacío: completar con el historial importado
            await conn.query(
              `UPDATE leads SET historial=?, asesor_id=?, asesor_nombre=?, tipif_vend=?, tipif_hora=?, sin_asignar=?, rotaciones=?, obs_asesor=COALESCE(NULLIF(obs_asesor,''),?) WHERE id=?`,
              [JSON.stringify(historialArray), asesorId, asesorNombre, tipifVend, hora, sinAsignar, rotaciones, obsAsesor, existing[0].id]
            );
            if (enBlacklistImport) bloqueadosTernaImport.push({ id: existing[0].id, n1: n1Raw });
            actualizados++;
          } else if (existingHist.length > 0 && !existingObs && obsAsesor) {
            // Historial ya existe pero falta obs_asesor (p.ej. DNI de una re-importación)
            await conn.query(
              `UPDATE leads SET obs_asesor=? WHERE id=?`,
              [obsAsesor, existing[0].id]
            );
            actualizados++;
          } else {
            existentes++;
          }
        } else {
          const [result] = await conn.query(
            `INSERT INTO leads (campana, distrito, n1, n2, tipif_back, asesor_id, asesor_nombre, fecha, hora_asig, sin_asignar, tipif_vend, tipif_hora, historial, rotaciones, obs_asesor, creado_por_id, creado_por_nombre, creado_por_usuario, creado_desde_ip)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [campana, distrito, n1Raw, n2Clean, tipifBack, asesorId, asesorNombre, fechaLead, hora, sinAsignar, tipifVend, hora, JSON.stringify(historialArray), rotaciones, obsAsesor, req.user.id, cargadoPorImport, req.user.usuario || '', ipCarga]
          );
          creados++;
          if (enBlacklistImport) {
            bloqueadosTernaImport.push({ id: result.insertId, n1: n1Raw });
          } else if (esTipificacionOrigen(tipifVend)) {
            await bloquearOtrasCampanasDelDia(conn, { id:result.insertId, n1:n1Raw, fecha:fechaLead, campana });
          }
        }
      } catch (recordErr) {
        console.error(`[import-legacy] Error en fila ${idx + 1}:`, recordErr.message);
        errores++;
        erroresDetalle.push({ fila: idx + 1, n1: l.n1, motivo: recordErr.message });
      }
    }

    await conn.commit();

    res.json({
      ok: true,
      procesados: registros.length,
      creados,
      actualizados,
      existentes,
      errores,
      erroresDetalle: erroresDetalle.slice(0, 30),
      bloqueados_terna: bloqueadosTernaImport,
    });

  } catch (e) {
    try { await conn.rollback(); } catch(re) { /* ignore */ }
    console.error('[import-legacy] Error general, rollback aplicado:', e.message);
    res.status(500).json({ ok: false, mensaje: 'Error en la importación masiva. Rollback aplicado.', detalle: e.message });
  } finally {
    conn.release();
  }
});

// POST /api/leads
router.post('/', auth(ROLES_BO), async (req, res) => {
  try {
    const leads = Array.isArray(req.body) ? req.body : [req.body];

    if (leads.length > 500)
      return res.status(400).json({ ok: false, mensaje: 'No se pueden crear más de 500 leads a la vez' });

    const fechaHoy  = fechaPeruHoy();
    const horaAhora = horaPeruAhora();
    let creados = 0;
    let omitidos = 0;
    const ids = [];
    const fechasUsadas = [];
    const omitidosN1 = [];
    const bloqueadosTerna = [];
    const cargaAutomaticaPrizma = esCargaAutomaticaPrizma(req.user.usuario);
    const responsablesBack = cargaAutomaticaPrizma ? await obtenerResponsablesBackActivos() : [];
    // Se resuelve una sola vez: es siempre el mismo usuario autenticado en
    // todas las iteraciones del lote (antes se repetia la misma consulta por
    // cada lead sin responsable aleatorio).
    const nombreUsuarioActual = await nombreUsuario(req.user.id);

    // Validar todas las fechas antes de insertar para evitar lotes parciales.
    for (const l of leads) {
      const fechaLead = l.fecha || fechaHoy;
      const n1Normalizado = normalizarN1(l.n1);
      const usuarioWhatsapp = normalizarUsuarioWhatsapp(l.usuario_whatsapp);
      const errores = validar([
        errorFecha(fechaLead, 'fecha'),
        errorTexto(l.n1, 'n1', { max: 30 }),
        errorTexto(usuarioWhatsapp, 'usuario_whatsapp', { max: 100 }),
        errorTexto(l.tipo_contacto, 'tipo_contacto', { max: 20 }),
        errorTexto(l.direccion, 'direccion', { max: 1000 }),
        errorTexto(l.coordenadas, 'coordenadas', { max: 255 }),
        errorTexto(l.obs_back, 'obs_back', { max: 2000 }),
      ]);
      if (errores) return res.status(400).json({ ok: false, mensaje: errores[0] });
      if (!n1Normalizado && !usuarioWhatsapp) {
        return res.status(400).json({ ok: false, mensaje: 'Ingresa un N1 o un usuario de WhatsApp' });
      }
    }

    // --- Pre-carga en bloque para evitar N+1 ----------------------------------
    // Antes, cada lead del lote disparaba hasta 3 consultas propias (duplicado
    // del dia, blacklist TERNA, mas antiguo del dia) mas la resolucion de
    // asesor por nombre/id — con lotes de hasta 500 leads eso eran miles de
    // consultas secuenciales, varias de ellas forzando ademas un escaneo
    // completo (ver n1_normalizado). Ahora se resuelven con un puñado de
    // consultas para todo el lote y se consultan en memoria dentro del for.
    // Los mapas de duplicado/mas-antiguo se van completando a medida que se
    // insertan filas, para seguir detectando duplicados repetidos dentro del
    // mismo lote (antes lo lograba porque cada chequeo era una consulta fresca).
    const n1sLote = [...new Set(leads.map(l => normalizarN1(l.n1)).filter(Boolean))];
    const fechasLote = [...new Set(leads.map(l => l.fecha || fechaHoy))];
    const asesorIdsLote = [...new Set(leads.map(l => l.asesor_id).filter(Boolean))];
    const asesorNombresLote = [...new Set(
      leads.filter(l => !l.asesor_id && (l.asesor_nombre || l.asesor))
        .map(l => String(l.asesor_nombre || l.asesor).trim().toLowerCase())
        .filter(Boolean)
    )];

    const duplicadoMismaCampanaMap = new Map(); // `${n1}|${fecha}|${campana}` -> id
    const ternaSet = new Set();                  // n1_normalizado con TERNA alguna vez
    const masAntiguoDelDiaMap = new Map();       // `${n1}|${fecha}` -> id mas antiguo
    const usuariosPorId = new Map();
    const usuariosPorNombre = new Map();

    if (n1sLote.length) {
      const inN1 = n1sLote.map(() => '?').join(',');
      const inFechas = fechasLote.map(() => '?').join(',');

      const [dupRows] = await db.query(`
        SELECT id, n1_normalizado, fecha, campana FROM leads
        WHERE n1_normalizado IN (${inN1}) AND fecha IN (${inFechas})
      `, [...n1sLote, ...fechasLote]);
      for (const r of dupRows) {
        const clave = `${r.n1_normalizado}|${r.fecha}|${normalizarCampana(r.campana) || '—'}`;
        if (!duplicadoMismaCampanaMap.has(clave)) duplicadoMismaCampanaMap.set(clave, r.id);
      }

      const [antiguoRows] = await db.query(`
        SELECT id, n1_normalizado, fecha FROM leads
        WHERE n1_normalizado IN (${inN1}) AND fecha IN (${inFechas})
        ORDER BY created_at ASC, id ASC
      `, [...n1sLote, ...fechasLote]);
      for (const r of antiguoRows) {
        const clave = `${r.n1_normalizado}|${r.fecha}`;
        if (!masAntiguoDelDiaMap.has(clave)) masAntiguoDelDiaMap.set(clave, r.id);
      }

      const [ternaRows] = await db.query(`
        SELECT DISTINCT n1_normalizado FROM leads
        WHERE n1_normalizado IN (${inN1}) AND UPPER(TRIM(tipif_vend)) = 'TERNA'
      `, n1sLote);
      for (const r of ternaRows) ternaSet.add(r.n1_normalizado);
    }
    if (asesorIdsLote.length) {
      const [rows] = await db.query(
        `SELECT id, nombre FROM usuarios WHERE id IN (${asesorIdsLote.map(() => '?').join(',')})`,
        asesorIdsLote
      );
      for (const r of rows) usuariosPorId.set(Number(r.id), r.nombre);
    }
    if (asesorNombresLote.length) {
      const [rows] = await db.query(
        `SELECT id, nombre FROM usuarios WHERE LOWER(TRIM(nombre)) IN (${asesorNombresLote.map(() => '?').join(',')})`,
        asesorNombresLote
      );
      for (const r of rows) usuariosPorNombre.set(String(r.nombre).trim().toLowerCase(), { id: r.id, nombre: r.nombre });
    }

    for (const l of leads) {
      const fechaLead = l.fecha || fechaHoy;
      const n1Normalizado = normalizarN1(l.n1);
      const usuarioWhatsapp = normalizarUsuarioWhatsapp(l.usuario_whatsapp);
      const campanaNormalizada = normalizarCampana(l.campana);

      // El alta individual solicita esta comprobacion. La carga masiva conserva
      // su flujo de vista previa y su opcion explicita de incluir duplicados.
      if (l.verificar_duplicado && n1Normalizado) {
        const [duplicados] = await db.query(`
          SELECT id, n1, fecha
          FROM leads
          WHERE n1_normalizado = ?
          ORDER BY created_at DESC
          LIMIT 1
        `, [n1Normalizado]);
        if (duplicados.length) {
          return res.status(409).json({
            ok: false,
            duplicado: true,
            mensaje: `El N1 ${l.n1} ya existe en la fecha ${duplicados[0].fecha}`,
            existente: duplicados[0],
          });
        }
      }

      // Mismo N1 + misma fecha + misma campaña ya cargado: se omite en
      // silencio, sin crear una fila nueva. Un N1 repetido en OTRA campaña
      // el mismo día no entra aquí — sigue siendo un lead independiente y
      // válido, que cuenta aparte en las métricas de esa campaña.
      const claveDuplicado = `${n1Normalizado}|${fechaLead}|${campanaNormalizada || '—'}`;
      if (n1Normalizado && duplicadoMismaCampanaMap.has(claveDuplicado)) {
        omitidos++;
        omitidosN1.push(n1Normalizado);
        continue;
      }

      let asesorId = l.asesor_id || null;
      let asesorNombre = '';

      if (asesorId) {
        // El nombre se obtiene de la BD, no del body
        const nombreEncontrado = usuariosPorId.get(Number(asesorId));
        if (nombreEncontrado) asesorNombre = nombreEncontrado;
        else asesorId = null;
      } else if (l.asesor_nombre || l.asesor) {
        const nombreBuscar = String(l.asesor_nombre || l.asesor).trim().toLowerCase();
        const encontrado = usuariosPorNombre.get(nombreBuscar);
        if (encontrado) { asesorId = encontrado.id; asesorNombre = encontrado.nombre; }
      }

      const horaFinal  = asesorId ? horaAhora : '';
      const tipifBackInicial = normalizarTipifBack(l.tipif_back);
      const enBlacklist = ternaSet.has(n1Normalizado);
      const claveAntiguo = `${n1Normalizado}|${fechaLead}`;
      const bloquearRotacion = !enBlacklist && masAntiguoDelDiaMap.has(claveAntiguo);
      const obsBackInicial = !tipifBackInicial ? '' : (tipifBackInicial === 'DERIVADO' ? 'DERIVADO' : 'LLAMAR AHORA');
      const responsableBack = elegirAleatorio(responsablesBack);
      const autorCarga = responsableBack || {
        id: req.user.id,
        nombre: nombreUsuarioActual,
        usuario: req.user.usuario || '',
      };
      const nombreCargador = autorCarga.nombre;
      const datosOrigenAutomatico = cargaAutomaticaPrizma ? {
        origenCarga: 'Sistema Prizma',
        origenUsuario: req.user.usuario || 'sistema-prizma',
        asignacionAutomatica: true,
      } : {};
      const historial  = asesorId
        ? JSON.stringify([{ asesor: asesorNombre, hora: horaFinal, fecha: fechaLead, asignadoPor: nombreCargador, cargadoPor: nombreCargador, cargadoPorUsuario: autorCarga.usuario, motivo: 'Asignacion inicial', obsBackPersonal:obsBackInicial, tipifBackOriginal:tipifBackInicial, tipifBackSlot:1, ...datosOrigenAutomatico }])
        : JSON.stringify([{ tipo: 'CARGA', cargadoPor: nombreCargador, cargadoPorUsuario: autorCarga.usuario, hora: horaPeruAhora(), fecha: fechaLead, motivo: cargaAutomaticaPrizma ? 'Carga automatica Prizma' : 'Carga inicial', ...datosOrigenAutomatico }]);

      const tipifBack = tipifBackInicial;
      const registraAutor = tipifBack === 'DERIVADO' || tipifBack === 'LLAMANDO';
      const derivadoPorNombre = registraAutor ? nombreUsuarioActual : '';
      const [result] = await db.query(`
        INSERT INTO leads (campana, distrito, n1, n2, usuario_whatsapp, tipo_contacto, direccion, coordenadas, obs_back, tipif_back, derivado_por_id, derivado_por_nombre, asesor_id, asesor_nombre, fecha, hora_asig, sin_asignar, historial, rotaciones, creado_por_id, creado_por_nombre, creado_por_usuario, creado_desde_ip)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        campanaNormalizada, l.distrito||'', n1Normalizado, l.n2||null, usuarioWhatsapp,
        l.tipo_contacto||'LLAMADA', l.direccion||'', l.coordenadas||'', l.obs_back||'', tipifBack,
        registraAutor ? req.user.id : null, derivadoPorNombre,
        asesorId, asesorNombre, fechaLead, horaFinal, asesorId?0:1, historial, asesorId?1:0,
        autorCarga.id, nombreCargador, autorCarga.usuario, req.ip || req.socket?.remoteAddress || ''
      ]);
      ids.push(result.insertId);
      if (n1Normalizado) {
        if (!duplicadoMismaCampanaMap.has(claveDuplicado)) duplicadoMismaCampanaMap.set(claveDuplicado, result.insertId);
        if (!masAntiguoDelDiaMap.has(claveAntiguo)) masAntiguoDelDiaMap.set(claveAntiguo, result.insertId);
      }
      if (enBlacklist) {
        await db.query(`UPDATE leads SET tipif_vend='TERNA', tipif_hora=? WHERE id=?`, [horaAhora, result.insertId]);
        bloqueadosTerna.push({ id: result.insertId, n1: n1Normalizado });
      } else if (bloquearRotacion) {
        await db.query(`UPDATE leads SET tipif_vend='NO ROTAR', tipif_hora=? WHERE id=?`, [horaAhora, result.insertId]);
      }
      fechasUsadas.push(fechaLead);
      creados++;
    }

    res.json({
      ok: true,
      creados,
      omitidos,
      omitidos_n1: omitidosN1,
      ids,
      bloqueados_terna: bloqueadosTerna,
      mensaje: `${creados} lead(s) creado(s)${omitidos ? `, ${omitidos} omitido(s) por ya existir en la misma campaña ese día` : ''}`,
      fecha_usada: fechasUsadas[0] || fechaHoy,
      fechas_usadas: [...new Set(fechasUsadas)],
    });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al crear leads' });
  }
});

// PATCH /api/leads/:id/datos-back
// Datos descriptivos que Back Office prepara para el asesor.
router.patch('/:id/datos-back', auth(ROLES_BO), async (req, res) => {
  try {
    const { tipo_contacto, direccion, coordenadas, obs_back, distrito, n1, n2, campana } = req.body;
    const errores = validar([
      errorTexto(tipo_contacto, 'tipo_contacto', { max: 20 }),
      errorTexto(direccion, 'direccion', { max: 1000 }),
      errorTexto(coordenadas, 'coordenadas', { max: 255 }),
      errorTexto(obs_back, 'obs_back', { max: 2000 }),
      errorTexto(distrito, 'distrito', { max: 100 }),
      errorTexto(campana, 'campana', { max: 100 }),
    ]);
    if (errores) return res.status(400).json({ ok: false, mensaje: errores[0] });

    const n1Normalizado = n1 === undefined ? undefined : normalizarN1(n1);
    const n2Normalizado = n2 === undefined ? undefined : (limpiarN2(n2) || '');
    if (n1 !== undefined && n1Normalizado.length < 6) {
      return res.status(400).json({ ok: false, mensaje: 'N1 debe contener al menos 6 dígitos' });
    }
    if (n2 !== undefined && String(n2 || '').trim() && !n2Normalizado) {
      return res.status(400).json({ ok: false, mensaje: 'N2 debe contener entre 7 y 9 dígitos' });
    }
    const [actuales] = await db.query(
      `SELECT id, n1, usuario_whatsapp, historial FROM leads WHERE id=? LIMIT 1`,
      [req.params.id]
    );
    if (!actuales.length) {
      return res.status(404).json({ ok: false, mensaje: 'Lead no encontrado' });
    }
    const n1ActualNormalizado = normalizarN1(actuales[0].n1);
    const esVinculacionWhatsapp = !n1ActualNormalizado
      && Boolean(normalizarUsuarioWhatsapp(actuales[0].usuario_whatsapp));
    // Al editar solamente el número de referencia (N2), el frontend también
    // envía el N1 actual. No debe bloquearse por otros ciclos/registros que ya
    // compartían legítimamente ese N1; la duplicidad se valida solo al cambiarlo.
    if (n1Normalizado !== undefined
      && n1Normalizado !== n1ActualNormalizado
      && !esVinculacionWhatsapp) {
      const [duplicados] = await db.query(
        `SELECT otro.id FROM leads actual
         INNER JOIN leads otro ON otro.fecha = actual.fecha AND otro.n1 = ? AND otro.id <> actual.id
         WHERE actual.id = ? LIMIT 1`,
        [n1Normalizado, req.params.id]
      );
      if (duplicados.length) {
        return res.status(409).json({ ok: false, mensaje: 'Ese N1 ya existe en la fecha del lead' });
      }
    }

    const campos = [];
    const valores = [];
    if (tipo_contacto !== undefined) { campos.push('tipo_contacto=?'); valores.push(tipo_contacto || 'LLAMADA'); }
    if (direccion     !== undefined) { campos.push('direccion=?');     valores.push(direccion || ''); }
    if (coordenadas   !== undefined) { campos.push('coordenadas=?');   valores.push(coordenadas || ''); }
    if (obs_back      !== undefined) { campos.push('obs_back=?');      valores.push(obs_back || ''); }
    if (distrito      !== undefined) { campos.push('distrito=?');      valores.push(distrito || ''); }
    if (n1Normalizado !== undefined) { campos.push('n1=?');            valores.push(n1Normalizado); }
    if (n2Normalizado !== undefined) { campos.push('n2=?');            valores.push(n2Normalizado || null); }
    if (campana       !== undefined) { campos.push('campana=?');       valores.push(normalizarCampana(campana) || '—'); }

    // El asesor titular ve obs_back a traves del snapshot "obsBackPersonal" que
    // quedo guardado en su asignacion vigente del historial (para no heredar la
    // nota de un asesor anterior tras una rotacion). Si Back Office edita
    // obs_back mientras el lead ya esta asignado, ese snapshot queda desactualizado
    // y la nota nueva nunca llega al asesor: hay que sincronizarlo aqui tambien.
    if (obs_back !== undefined) {
      const historialActual = historialArray(actuales[0].historial);
      const vigentes = asignacionesVigentesHistorial(historialActual);
      const ultimaVigente = vigentes[vigentes.length - 1];
      if (ultimaVigente) {
        const idx = historialActual.lastIndexOf(ultimaVigente);
        historialActual[idx] = { ...ultimaVigente, obsBackPersonal: obs_back || '' };
        campos.push('historial=?');
        valores.push(JSON.stringify(historialActual));
      }
    }
    if (!campos.length) return res.status(400).json({ ok: false, mensaje: 'No hay datos para actualizar' });

    valores.push(req.params.id);
    const [result] = await db.query(`UPDATE leads SET ${campos.join(', ')} WHERE id=?`, valores);
    if (!result.affectedRows) return res.status(404).json({ ok: false, mensaje: 'Lead no encontrado' });
    res.json({ ok: true, mensaje: 'Datos de Back Office guardados' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al guardar datos de Back Office' });
  }
});

// POST /api/leads/:id/otra-direccion
// Abre un nuevo ciclo comercial sin duplicar el cliente. Es la unica via que
// permite volver a trabajar manualmente un telefono con venta activa/instalada.
router.post('/:id/otra-direccion', auth(ROLES_BO), async (req, res) => {
  let conn;
  try {
    const { asesor_nombre, motivo } = req.body;
    const errores = validar([
      errorTexto(asesor_nombre, 'asesor_nombre', { requerido:true, max:150 }),
      errorTexto(motivo, 'motivo', { max:1000 }),
    ]);
    if (errores) return res.status(400).json({ ok:false, mensaje:errores[0] });

    conn = await db.getConnection();
    await conn.beginTransaction();
    const [rows] = await conn.query(`SELECT * FROM leads WHERE id=? FOR UPDATE`, [req.params.id]);
    if (!rows.length) { await conn.rollback(); return res.status(404).json({ ok:false, mensaje:'Lead no encontrado' }); }
    const lead = rows[0];
    const [abiertos] = await conn.query(`SELECT id, numero_ciclo FROM lead_ciclos_venta WHERE lead_id=? AND estado='ABIERTO' LIMIT 1 FOR UPDATE`, [lead.id]);
    if (abiertos.length) {
      await conn.rollback();
      return res.status(409).json({ ok:false, mensaje:`Ya existe un ciclo abierto (Venta ${abiertos[0].numero_ciclo}). Debe cerrarse antes de abrir otra dirección.` });
    }
    const [usuarios] = await conn.query(`SELECT id,nombre FROM usuarios WHERE TRIM(nombre)=TRIM(?) AND activo=1 AND (cargo='asesor' OR JSON_CONTAINS(COALESCE(permisos,'[]'), JSON_QUOTE('asesor'))) LIMIT 1`, [asesor_nombre]);
    if (!usuarios.length) { await conn.rollback(); return res.status(404).json({ ok:false, mensaje:'Asesor no encontrado o inactivo' }); }
    const asesor = usuarios[0];
    const [[conteos]] = await conn.query(`
      SELECT
        (SELECT COUNT(*) FROM ventas WHERE TRIM(telefono1)=TRIM(?)) AS ventas,
        (SELECT COALESCE(MAX(numero_ciclo),0) FROM lead_ciclos_venta WHERE lead_id=?) AS max_ciclo
    `, [lead.n1 || '', lead.id]);
    const numeroCiclo = Math.max(Number(conteos.ventas || 0), Number(conteos.max_ciclo || 0)) + 1;
    const [actores] = await conn.query(`SELECT id,nombre,usuario,cargo FROM usuarios WHERE id=? LIMIT 1`, [req.user.id]);
    const actor = actores[0] || { id:req.user.id, nombre:req.user.nombre || 'Usuario', usuario:req.user.usuario || '', cargo:req.user.cargo || '' };
    const ip = req.ip || req.socket?.remoteAddress || '';
    const [ciclo] = await conn.query(`
      INSERT INTO lead_ciclos_venta
        (lead_id,numero_ciclo,tipo,estado,asesor_id,asesor_nombre,direccion,distrito,motivo,creado_por_id,creado_por_nombre,creado_por_usuario,creado_desde_ip)
      VALUES (?,?,'OTRA_DIRECCION','ABIERTO',?,?,?,?,?,?,?,?,?)
    `, [lead.id, numeroCiclo, asesor.id, asesor.nombre, '', '', String(motivo || '').trim(), actor.id, actor.nombre, actor.usuario || '', ip]);
    let historial = historialArray(lead.historial);
    const fecha = fechaPeruHoy();
    const hora = horaPeruAhora();
    historial.push({
      tipo:'CICLO_VENTA', subtipo:'OTRA_DIRECCION', accion:'ASIGNACION',
      cicloId:ciclo.insertId, numeroCiclo, asesor:asesor.nombre,
      asesorAnterior:lead.asesor_nombre || '',
      tipificacionAnterior:lead.tipif_vend || '', motivo:String(motivo || '').trim(),
      realizadoPor:actor.nombre, realizadoPorUsuario:actor.usuario || '', realizadoPorId:actor.id,
      ip, fecha, hora, ts:Date.now(),
    });
    const rotacionesReales = contarRotacionesHistorial(historial);
    await conn.query(`
      UPDATE leads SET asesor_id=?, asesor_nombre=?, hora_asig=?,
        sin_asignar=0, tipif_vend='', tipif_hora='', obs_asesor='', historial=?, rotaciones=?
      WHERE id=?
    `, [asesor.id, asesor.nombre, hora, JSON.stringify(historial), rotacionesReales, lead.id]);
    await conn.commit();
    res.json({ ok:true, ciclo_id:ciclo.insertId, numero_ciclo:numeroCiclo, asesor_id:asesor.id, asesor:asesor.nombre, historial, mensaje:`Venta ${numeroCiclo} — OTRA DIRECCIÓN habilitada para ${asesor.nombre}` });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('[otra-direccion]', e);
    res.status(500).json({ ok:false, mensaje:'No se pudo abrir el ciclo de otra dirección' });
  } finally {
    if (conn) conn.release();
  }
});

// POST /api/leads/:id/rotar
// Actualiza el lead existente con el nuevo asesor (sin crear duplicados).
// Preserva el historial completo con asesorAnterior, rotadoPor y tipifBackAntes.
router.post('/:id/rotar', auth(ROLES_BO), async (req, res) => {
  let conn;
  let claveGrupoRotando = null;
  try {
    const { asesor_nombre, motivo, asesor_id_esperado, rotaciones_esperadas, reactivacion_manual } = req.body;
    if (!asesor_nombre?.trim()) {
      return res.status(400).json({ ok: false, mensaje: 'Selecciona el nuevo asesor' });
    }

    // Bloqueo rapido en memoria, antes de abrir transaccion: si otro Back
    // Office ya esta rotando este mismo numero/dia en este instante, se
    // rechaza al toque en vez de competir por los mismos locks de fila.
    const [preLead] = await db.query(`SELECT n1, fecha FROM leads WHERE id = ?`, [req.params.id]);
    if (!preLead.length) {
      return res.status(404).json({ ok: false, mensaje: 'Lead no encontrado' });
    }
    claveGrupoRotando = `${normalizarN1(preLead[0].n1)}|${normalizarFechaAsignacion(preLead[0].fecha)}`;
    if (gruposRotandose.has(claveGrupoRotando)) {
      return res.status(409).json({ ok: false, mensaje: 'Este número ya se está rotando en este momento. Espera un segundo e inténtalo de nuevo.' });
    }
    gruposRotandose.add(claveGrupoRotando);

    conn = await db.getConnection();
    await conn.beginTransaction();

    const [leads] = await conn.query(`SELECT * FROM leads WHERE id = ? FOR UPDATE`, [req.params.id]);
    if (!leads.length) {
      await conn.rollback();
      return res.status(404).json({ ok: false, mensaje: 'Lead no encontrado' });
    }
    const lead = leads[0];
    const historialInicial = historialArray(lead.historial);
    // Control optimista dentro del mismo bloqueo de fila: si otro Back Office
    // rotó este lead después de que el cliente lo seleccionó, la segunda
    // operación se rechaza en vez de volver a asignar información obsoleta.
    const envioVersion = Object.prototype.hasOwnProperty.call(req.body, 'rotaciones_esperadas');
    const esperadoId = asesor_id_esperado == null || asesor_id_esperado === '' ? null : Number(asesor_id_esperado);
    const actualId = lead.asesor_id == null ? null : Number(lead.asesor_id);
    const esperadas = Number(rotaciones_esperadas);
    const actuales = Number(lead.rotaciones || 0);
    if (envioVersion && (esperadoId !== actualId || !Number.isInteger(esperadas) || esperadas !== actuales)) {
      await conn.rollback();
      return res.status(409).json({
        ok: false,
        codigo: 'ROTACION_DESACTUALIZADA',
        mensaje: `Este cliente ya fue actualizado por otro usuario${lead.asesor_nombre ? ` y ahora está asignado a ${lead.asesor_nombre}` : ''}. La lista se sincronizó; vuelve a seleccionarlo.`,
        actual: { id:Number(lead.id), asesor_id:actualId, asesor:lead.asesor_nombre || '', rotaciones:actuales },
      });
    }
    const fechaLead = normalizarFechaAsignacion(lead.fecha);
    const principalId = await idLeadMasAntiguoDelDia(conn, lead.n1, fechaLead);
    if (principalId && Number(principalId) !== Number(lead.id)) {
      await conn.rollback();
      return res.status(409).json({ ok:false, mensaje:'Numero prohibido: NO ROTAR. Solo se rota el primer registro del numero en el dia.' });
    }
    // SIN COBERTURA se rota sin limite -- solo se libera al concretarse una
    // venta real; hasta entonces se mantiene fija en la base principal.
    const n1Clean = String(lead.n1 || '').trim();
    const [ventasProtegidas] = await conn.query(
      `SELECT v.id, v.estado, v.estado_grab, v.motivo_seguimiento,
              v.created_at AS venta_created_at, cv.estado_validacion,
              cv.fecha_validacion, fechas.fecha_grabacion, fechas.fecha_seguimiento
       FROM ventas v
       LEFT JOIN (
         SELECT vh.venta_id, vh.valor_nuevo AS estado_validacion, vh.created_at AS fecha_validacion
         FROM venta_historial vh
         INNER JOIN (
           SELECT venta_id, MAX(id) AS max_id FROM venta_historial
           WHERE campo='estado' AND tipo='CAMBIO_VALIDACION' GROUP BY venta_id
         ) ult ON ult.max_id=vh.id
       ) cv ON cv.venta_id=v.id
       LEFT JOIN (
         SELECT venta_id,
                MAX(CASE WHEN campo='estado_grab' THEN created_at END) AS fecha_grabacion,
                MAX(CASE WHEN modulo='Seguimiento' AND campo IN ('estado','motivo_seguimiento','tramo_seguimiento') THEN created_at END) AS fecha_seguimiento
         FROM venta_historial GROUP BY venta_id
       ) fechas ON fechas.venta_id=v.id
       WHERE TRIM(v.telefono1) = ? ORDER BY v.id DESC LIMIT 1`,
      [n1Clean]
    );
    const tipifInternaVentaActual = tipificacionInternaVenta(ventasProtegidas[0]);
    const esVentaCaida = tipifInternaVentaActual?.tipificacion === 'VENTA CAIDA';
    const tipifHistorial = ultimaTipificacionVendedorHistorial(lead.historial);
    const tipifProteccion = String(lead.tipif_vend || '').trim().toUpperCase() === 'NO ROTAR' && tipifHistorial
      ? tipifHistorial
      : lead.tipif_vend;
    if (tipificacionProhibida(tipifProteccion) && !esVentaCaida) {
      await conn.rollback();
      return res.status(409).json({ ok: false, mensaje: `Numero prohibido: ${String(tipifProteccion).toUpperCase()}` });
    }
    if (ventasProtegidas.length > 0 && !esVentaCaida) {
      await conn.rollback();
      return res.status(409).json({ ok: false, mensaje: 'Número protegido: ya generó una venta y no se puede rotar' });
    }

    const [usuarios] = await conn.query(`
      SELECT id, TRIM(nombre) AS nombre
      FROM usuarios
      WHERE TRIM(nombre) = ?
        AND activo = 1
        AND (cargo = 'asesor' OR JSON_CONTAINS(COALESCE(permisos, '[]'), JSON_QUOTE('asesor')))
      LIMIT 1
    `, [asesor_nombre.trim()]);
    if (!usuarios.length) {
      await conn.rollback();
      return res.status(404).json({ ok: false, mensaje: 'Asesor no encontrado o inactivo' });
    }
    const asesorNuevo = usuarios[0];
    const esMismoAsesor = Number(lead.asesor_id) === Number(asesorNuevo.id);
    const asignacionesDelMismo = historialInicial.filter(h =>
      h?.asesor
      && !['TIPIF_VEND','TIPIF_BACK','DERIVADO','QUITAR_ASIGNACION'].includes(String(h?.tipo || '').toUpperCase())
      && normalizarNombreAsesor(h.asesor) === normalizarNombreAsesor(asesorNuevo.nombre)
    );
    const ultimaDelMismo = asignacionesDelMismo.reduce((ultima, actual) => {
      const marcaUltima = `${normalizarFechaAsignacion(ultima?.fecha)} ${String(ultima?.hora || '').padStart(5, '0')}`;
      const marcaActual = `${normalizarFechaAsignacion(actual?.fecha)} ${String(actual?.hora || '').padStart(5, '0')}`;
      return !ultima || marcaActual >= marcaUltima ? actual : ultima;
    }, null);
    // La reasignacion manual es una excepcion deliberada: Back Data puede
    // devolver el lead a cualquier asesor que ya lo tuvo, incluso al titular
    // actual y dentro del mismo dia. La rotacion inteligente no usa esta marca.
    const esReasignacionManual = reactivacion_manual === true && Boolean(ultimaDelMismo);
    const esReactivacionManual = esReasignacionManual
      && normalizarFechaAsignacion(ultimaDelMismo.fecha) < fechaPeruHoy();
    if (esMismoAsesor && !esReasignacionManual) {
      await conn.rollback();
      return res.status(409).json({ ok: false, mensaje: 'Selecciona un asesor diferente al actual' });
    }
    // Si OTRA DIRECCION ya tiene una instancia abierta, cada nueva asignación
    // manual crea OTRO formulario; nunca reemplaza el anterior.
    const [ciclosAbiertosManual] = await conn.query(`SELECT id FROM lead_ciclos_venta WHERE lead_id=? AND estado='ABIERTO' LIMIT 1`, [lead.id]);
    if (reactivacion_manual === true && ciclosAbiertosManual.length) {
      const [usuariosInstancia] = await conn.query(`
        SELECT id,TRIM(nombre) nombre FROM usuarios
        WHERE TRIM(nombre)=? AND activo=1
          AND (cargo='asesor' OR JSON_CONTAINS(COALESCE(permisos,'[]'), JSON_QUOTE('asesor')))
        LIMIT 1
      `, [asesor_nombre.trim()]);
      if (!usuariosInstancia.length) { await conn.rollback(); return res.status(404).json({ok:false,mensaje:'Asesor no encontrado o inactivo'}); }
      const asesorInstancia = usuariosInstancia[0];
      const parentId = Number(lead.lead_origen_id || lead.id);
      const [[secuencia]] = await conn.query(`
        SELECT GREATEST(
          COALESCE((SELECT MAX(instancia_venta_numero) FROM leads WHERE id=? OR lead_origen_id=?),0),
          COALESCE((SELECT MAX(numero_ciclo) FROM lead_ciclos_venta WHERE lead_id=? OR lead_id IN (SELECT id FROM leads WHERE lead_origen_id=?)),0)
        ) AS ultimo
      `, [parentId,parentId,parentId,parentId]);
      const numeroInstancia = Number(secuencia.ultimo || 0) + 1;
      const actorNombre = await nombreUsuario(req.user.id);
      const fechaInstancia = fechaPeruHoy();
      const horaInstancia = horaPeruAhora();
      const historialInstancia = [{
        tipo:'CICLO_VENTA',subtipo:'OTRA_DIRECCION',accion:'ASIGNACION',numeroCiclo:numeroInstancia,
        asesor:asesorInstancia.nombre,asesorAnterior:lead.asesor_nombre || '',
        realizadoPor:actorNombre,realizadoPorUsuario:req.user.usuario || '',realizadoPorId:req.user.id,
        motivo:String(motivo || '').trim() || 'Nueva venta del mismo cliente',
        fecha:fechaInstancia,hora:horaInstancia,ts:Date.now(),
      }];
      const [nueva] = await conn.query(`
        INSERT INTO leads
          (campana,distrito,n1,n2,usuario_whatsapp,tipo_contacto,direccion,coordenadas,obs_back,
           asesor_id,asesor_nombre,fecha,hora_asig,rotaciones,sin_asignar,tipif_vend,tipif_hora,obs_asesor,historial,
           creado_por_id,creado_por_nombre,creado_por_usuario,creado_desde_ip,lead_origen_id,instancia_venta_numero,instancia_tipo)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,0,'','','',?,?,?,?,?,?,?,'OTRA_DIRECCION')
      `, [lead.campana||'',lead.distrito||'',lead.n1,lead.n2||null,lead.usuario_whatsapp||'',lead.tipo_contacto||'LLAMADA',
          '', '', '', asesorInstancia.id,asesorInstancia.nombre,fechaInstancia,horaInstancia,JSON.stringify(historialInstancia),
          req.user.id,actorNombre,req.user.usuario||'',req.ip||req.socket?.remoteAddress||'',parentId,numeroInstancia]);
      const [cicloNuevo] = await conn.query(`
        INSERT INTO lead_ciclos_venta
          (lead_id,numero_ciclo,tipo,estado,asesor_id,asesor_nombre,direccion,distrito,motivo,creado_por_id,creado_por_nombre,creado_por_usuario,creado_desde_ip)
        VALUES (?,?,'OTRA_DIRECCION','ABIERTO',?,?, '', '', ?,?,?,?,?)
      `, [nueva.insertId,numeroInstancia,asesorInstancia.id,asesorInstancia.nombre,String(motivo||'').trim(),req.user.id,actorNombre,req.user.usuario||'',req.ip||req.socket?.remoteAddress||'']);
      historialInstancia[0].cicloId = cicloNuevo.insertId;
      await conn.query(`UPDATE leads SET historial=? WHERE id=?`, [JSON.stringify(historialInstancia),nueva.insertId]);
      await conn.commit();
      return res.json({ok:true,id:nueva.insertId,asesor_id:asesorInstancia.id,asesor:asesorInstancia.nombre,
        nueva_instancia:true,numero_instancia:numeroInstancia,mensaje:`Formulario ${numeroInstancia} · OTRA DIRECCIÓN asignado a ${asesorInstancia.nombre}`});
    }

    const rotadorNombre = await nombreUsuario(req.user.id);

    const historial = [...historialInicial];
    const asesorYaUsado = historial.some(h =>
      [h?.asesor, h?.asesorAnterior].some(nombre =>
        String(nombre || '').trim().toUpperCase() === String(asesorNuevo.nombre || '').trim().toUpperCase()
      )
    );
    if (asesorYaUsado && !esReasignacionManual) {
      await conn.rollback();
      return res.status(409).json({ ok: false, mensaje: 'Este número ya fue asignado anteriormente a ese asesor' });
    }
    const fechaUltima = normalizarFechaAsignacion(lead.fecha) || fechaPeruHoy();
    const horaUltima  = String(lead.hora_asig || '').trim();
    const ultimaAsignacion = horaUltima ? new Date(`${fechaUltima}T${horaUltima}:00-05:00`) : null;
    const esBaseHoy = fechaUltima === fechaPeruHoy();
    if (!esBaseHoy && ultimaAsignacion && !Number.isNaN(ultimaAsignacion.getTime())) {
      const minutos = Math.floor((Date.now() - ultimaAsignacion.getTime()) / 60000);
      if (minutos < 120) {
        await conn.rollback();
        return res.status(409).json({ ok: false, mensaje: `Deben pasar 2 horas desde la última asignación. Faltan ${120 - Math.max(0, minutos)} minutos` });
      }
    }
    const fecha = fechaPeruHoy();
    const hora  = horaPeruAhora();
    historial.push({
      tipo:          esReactivacionManual ? 'REACTIVACION_MANUAL' : (esReasignacionManual ? 'REASIGNACION_MANUAL' : 'ROTACION'),
      asesor:        asesorNuevo.nombre,
      asesorAnterior: lead.asesor_nombre || 'Sin asignar',
      rotadoPor:     rotadorNombre,
      tipifBackAntes: lead.tipif_back || '',
      tipifVendAntes: lead.tipif_vend || '',
      obsAsesorAntes: lead.obs_asesor || '',
      obsBackAntes: (() => {
        const asignaciones = historial.filter(h =>
          h?.asesor && !['TIPIF_VEND','TIPIF_BACK','DERIVADO'].includes(String(h.tipo || '').toUpperCase())
          && String(h.asesor).trim() === String(lead.asesor_nombre || '').trim()
        );
        return asignaciones[asignaciones.length - 1]?.obsBackPersonal || '';
      })(),
      hora,
      fecha,
      motivo: String(motivo || '').trim() || (esReactivacionManual
        ? 'Reactivacion manual para la base de hoy'
        : (esReasignacionManual ? 'Reasignacion manual al mismo asesor' : 'Rotacion manual')),
    });

    // Actualiza el registro existente: no crea duplicados.
    const rotacionesReales = contarRotacionesHistorial(historial);
    await conn.query(`
      UPDATE leads SET
        asesor_id = ?, asesor_nombre = ?,
        hora_asig = ?, sin_asignar = 0,
        rotaciones = ?,
        tipif_vend = '', tipif_hora = '', obs_asesor = '',
        historial = ?
      WHERE id = ?
    `, [asesorNuevo.id, asesorNuevo.nombre, hora, rotacionesReales, JSON.stringify(historial), req.params.id]);

    await bloquearDuplicadosAlRotar(conn, lead);
    await conn.commit();
    res.json({
      ok: true,
      id: parseInt(req.params.id),
      asesor_id:asesorNuevo.id,
      asesor: asesorNuevo.nombre,
      historial,
      rotaciones:rotacionesReales,
      reactivado:esReactivacionManual,
      reasignado_manual:esReasignacionManual,
      mensaje: esReactivacionManual
        ? `Lead reactivado para ${asesorNuevo.nombre} en la base de hoy`
        : (esReasignacionManual
          ? `Lead reasignado manualmente a ${asesorNuevo.nombre}`
          : `Registro rotado a ${asesorNuevo.nombre}`),
    });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al rotar el lead' });
  } finally {
    if (claveGrupoRotando) gruposRotandose.delete(claveGrupoRotando);
    if (conn) conn.release();
  }
});

// PATCH /api/leads/:id
router.patch('/:id', auth(ROLES_BO), async (req, res) => {
  try {
    const { asesor_nombre, tipif_back, tipif_back_2, hora_asig, historial } = req.body;

    const errores = validar([
      errorHora(hora_asig, 'hora_asig'),
      errorHistorial(historial),
      errorTexto(tipif_back, 'tipif_back', { max: 200 }),
      errorTexto(tipif_back_2, 'tipif_back_2', { max: 200 }),
    ]);
    if (errores) return res.status(400).json({ ok: false, mensaje: errores[0] });

    const [rows] = await db.query(`SELECT * FROM leads WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Lead no encontrado' });
    const lead = rows[0];
    if (asesor_nombre) {
      const [ventasCerradas] = await db.query(`SELECT id FROM ventas WHERE TRIM(telefono1)=TRIM(?) LIMIT 1`, [lead.n1 || '']);
      if (ventasCerradas.length) {
        return res.status(409).json({ ok:false, mensaje:'Número protegido: ya generó una venta y no se puede reasignar' });
      }
    }

    // Defensa del servidor: aunque un cliente antiguo o una selección pendiente
    // intente reasignarlo, estos números nunca pueden recibir otro asesor.
    if (asesor_nombre && tipificacionProhibida(lead.tipif_vend)) {
      return res.status(409).json({
        ok: false,
        mensaje: `Número prohibido: ${String(lead.tipif_vend).toUpperCase()}`,
      });
    }

    // Preserva el asesor existente cuando sólo cambia tipif_back u otros campos.
    // Si se envía asesor_nombre, se resuelve el nuevo asesor desde la BD.
    let asesorId = lead.asesor_id || null;
    let asesorNombreReal = lead.asesor_nombre || '';
    if (asesor_nombre) {
      const [uRows] = await db.query(`SELECT id, nombre FROM usuarios WHERE nombre = ?`, [asesor_nombre]);
      if (uRows.length) { asesorId = uRows[0].id; asesorNombreReal = uRows[0].nombre; }
    }

    const horaReal = hora_asig || horaPeruAhora();
    const tipifBackReal = tipif_back === undefined ? lead.tipif_back : normalizarTipifBack(tipif_back);
    const tipifBack2Real = tipif_back_2 === undefined ? (lead.tipif_back_2 || '') : normalizarTipifBack(tipif_back_2);

    // derivadoPor lo determina el backend desde req.user — el frontend no puede falsificarlo.
    let derivadoPorId     = lead.derivado_por_id;
    let derivadoPorNombre = lead.derivado_por_nombre;
    if (tipif_back !== undefined) {
      if (tipifBackReal === 'DERIVADO' || tipifBackReal === 'LLAMANDO') {
        derivadoPorId     = req.user.id;
        derivadoPorNombre = await nombreUsuario(req.user.id);
      } else {
        derivadoPorId     = null;
        derivadoPorNombre = '';
      }
    }

    let derivadoPor2Id = lead.derivado_por_2_id;
    let derivadoPor2Nombre = lead.derivado_por_2_nombre;
    if (tipif_back_2 !== undefined) {
      if (tipifBack2Real === 'DERIVADO' || tipifBack2Real === 'LLAMANDO') {
        derivadoPor2Id = req.user.id;
        derivadoPor2Nombre = await nombreUsuario(req.user.id);
      } else {
        derivadoPor2Id = null;
        derivadoPor2Nombre = '';
      }
    }

    const asesorCambia = !!asesor_nombre && asesor_nombre !== (lead.asesor_nombre || '');
    let reasignadoPorNombre = '';
    if (asesorCambia) {
      reasignadoPorNombre = await nombreUsuario(req.user.id);
    }

    // Las tipificaciones Back se aplican sobre el historial vigente de la BD.
    // No se confía en una copia enviada por el navegador porque el polling puede
    // volverla obsoleta y provocar que Back 2 se pierda o sobrescriba Back 1.
    const cambiaTipifBack = tipif_back !== undefined || tipif_back_2 !== undefined;
    let historialServidor = [];
    try { historialServidor = JSON.parse(lead.historial || '[]'); } catch { historialServidor = []; }
    let historialJSON;
    if (historial || cambiaTipifBack) {
      const histArr = cambiaTipifBack ? [...historialServidor] : [...historial];
      if (histArr.length > 0) {
        const lastIdx = histArr.length - 1;
        let lastEntry = { ...histArr[lastIdx] };
        if (asesorCambia) {
          if (!lastEntry.asesorAnterior) lastEntry.asesorAnterior = lead.asesor_nombre || '';
          if (reasignadoPorNombre) lastEntry.reasignadoPor = reasignadoPorNombre;
          // Preserva la tipificación que dejó el asesor anterior, para que la base
          // principal la siga mostrando hasta que el nuevo asesor tipifique.
          if (lastEntry.tipifVendAntes == null) lastEntry.tipifVendAntes = lead.tipif_vend || '';
          if (lastEntry.obsAsesorAntes == null) lastEntry.obsAsesorAntes = lead.obs_asesor || '';
        }
        histArr[lastIdx] = lastEntry;
      }
      if (cambiaTipifBack) {
        const valorOriginal = tipif_back_2 !== undefined ? tipifBack2Real : tipifBackReal;
        const slot = tipif_back_2 !== undefined ? 2 : 1;
        const obsBackPersonal = !valorOriginal ? '' : (valorOriginal === 'DERIVADO' ? 'DERIVADO' : 'LLAMAR AHORA');
        for (let i = histArr.length - 1; i >= 0; i--) {
          const h = histArr[i];
          if (h?.asesor && !['TIPIF_VEND','TIPIF_BACK','DERIVADO'].includes(String(h.tipo || '').toUpperCase()) && String(h.asesor).trim() === String(lead.asesor_nombre || '').trim()) {
            histArr[i] = { ...h, obsBackPersonal, tipifBackOriginal:valorOriginal, tipifBackSlot:slot };
            break;
          }
        }
        histArr.push({
          tipo: valorOriginal === 'DERIVADO' ? 'DERIVADO' : 'TIPIF_BACK',
          asesor: lead.asesor_nombre || '',
          hora: horaPeruAhora(),
          fecha: fechaPeruHoy(),
          tipifBackNueva: valorOriginal,
          tipifBackSlot: slot,
          obsBackPersonal,
          registradoPor: await nombreUsuario(req.user.id),
          motivo: slot === 2 ? 'Segunda tipificacion Back' : 'Cambio tipif. back',
        });
      }
      historialJSON = JSON.stringify(histArr);
    } else {
      historialJSON = lead.historial;
    }

    // Al cambiar de asesor se limpia la tipif_vend del NUEVO asesor (la ve vacía y
    // coloca la suya). La base principal sigue mostrando la del asesor anterior
    // derivándola del historial (tipifVendAntes) hasta que el nuevo tipifique.
    const sqlExtra = asesorCambia ? ', tipif_vend=?, tipif_hora=?, obs_asesor=?' : '';
    const paramsExtra = asesorCambia ? ['', '', ''] : [];

    const rotacionesReales = contarRotacionesHistorial(historialJSON);
    await db.query(`
      UPDATE leads SET asesor_id=?, asesor_nombre=?, tipif_back=?, tipif_back_2=?, hora_asig=?,
        sin_asignar=?, historial=?, rotaciones=?,
        derivado_por_id=?, derivado_por_nombre=?, derivado_por_2_id=?, derivado_por_2_nombre=?${sqlExtra}
      WHERE id=?
    `, [
      asesorId, asesorNombreReal, tipifBackReal, tipifBack2Real,
      horaReal, asesorId?0:1, historialJSON,
      rotacionesReales,
      derivadoPorId, derivadoPorNombre,
      derivadoPor2Id, derivadoPor2Nombre,
      ...paramsExtra,
      req.params.id
    ]);

    res.json({ ok: true, rotaciones:rotacionesReales, mensaje: 'Lead actualizado' });
  } catch(e) {
    console.error('Error actualizando lead:', e);
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar lead' });
  }
});

// Agrega un evento de tipificación (log cronológico) con marca de tiempo. La base
// principal muestra el de ts más reciente ("la más reciente gana"), y el historial de
// tipificaciones muestra todo el log. Evita duplicar si el último evento ya es del
// mismo asesor con el mismo valor.
function registrarTipifEvent(historial, asesor, tipif, datos = {}) {
  const eventos = historial.filter(h => h?.tipo === 'TIPIF_VEND');
  const ultimo = eventos[eventos.length - 1];
  if (ultimo && (ultimo.asesor || '') === (asesor || '') && (ultimo.tipif || '') === (tipif || '')) {
    if (datos.documento) ultimo.documento = datos.documento;
    return historial;
  }
  historial.push({ tipo:'TIPIF_VEND', asesor: asesor || '', tipif: tipif || '', ...datos, ts: Date.now(), hora: horaPeruAhora(), fecha: fechaPeruHoy() });
  return historial;
}

// PATCH /api/leads/:id/tipif
router.patch('/:id/tipif', auth(ROLES_ALL), async (req, res) => {
  try {
    const { tipif_vend, tipo_doc, documento, distrito, coordenadas } = req.body;
    const tipifNormalizada = normalizarTipifVendLegacy(tipif_vend).trim().toUpperCase();
    if (tipif_vend && String(tipif_vend).length > 200)
      return res.status(400).json({ ok: false, mensaje: 'tipif_vend no puede superar 200 caracteres' });
    let documentoTexto = '';
    if (tipifNormalizada === 'PREVENTA') {
      const tipoDoc = String(tipo_doc || '').trim().toUpperCase();
      const doc = String(documento || '').trim();
      const longitudes = { DNI:8, CE:9, RUC:11 };
      if (!longitudes[tipoDoc]) return res.status(400).json({ ok:false, mensaje:'Tipo de documento invalido' });
      if (!new RegExp(`^\\d{${longitudes[tipoDoc]}}$`).test(doc))
        return res.status(400).json({ ok:false, mensaje:`${tipoDoc} debe tener exactamente ${longitudes[tipoDoc]} digitos` });
      documentoTexto = `${tipoDoc}: ${doc}`;
    }
    if (tipifNormalizada === 'SIN COBERTURA') {
      const erroresDetalle = validar([
        errorTexto(distrito, 'distrito', { requerido:true, max:100 }),
        errorTexto(coordenadas, 'coordenadas', { requerido:true, max:255 }),
      ]);
      if (erroresDetalle) return res.status(400).json({ ok:false, mensaje:erroresDetalle[0] });
    }
    const [rows] = await db.query(`SELECT * FROM leads WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Lead no encontrado' });
    const lead = rows[0];
    const [ciclosTipif] = await db.query(`SELECT id,numero_ciclo,tipo FROM lead_ciclos_venta WHERE lead_id=? AND estado='ABIERTO' ORDER BY id DESC LIMIT 1`, [lead.id]);
    const cicloTipif = ciclosTipif[0] || null;
    const datosCicloTipif = cicloTipif ? { cicloId:cicloTipif.id, numeroCiclo:cicloTipif.numero_ciclo, subtipo:cicloTipif.tipo } : {};
    const idPrincipalDia = await idLeadMasAntiguoDelDia(db, lead.n1, normalizarFechaAsignacion(lead.fecha));
    if (!lead.lead_origen_id && idPrincipalDia && Number(idPrincipalDia) !== Number(lead.id)) {
      await db.query(`UPDATE leads SET tipif_vend='NO ROTAR', tipif_hora=? WHERE id=?`, [horaPeruAhora(), lead.id]);
      return res.status(409).json({ ok:false, tipif_vend:'NO ROTAR', mensaje:'Solo el primer registro del numero en el dia puede recibir tipificacion' });
    }
    // El asesor puede tipificar libremente un lead que paso por SIN
    // COBERTURA (para dejar constancia en su propia base); la base
    // principal lo sigue mostrando fijo en SIN COBERTURA del lado del
    // frontend hasta que exista una venta real -- no se bloquea aqui.
    const obsActual = String(lead.obs_asesor || '').trim();
    let obsFinal = documentoTexto && !obsActual.toUpperCase().includes(documentoTexto.toUpperCase())
      ? (obsActual ? `${obsActual} | ${documentoTexto}` : documentoTexto)
      : obsActual;
    if (tipifNormalizada === 'SIN COBERTURA') {
      obsFinal = String(coordenadas || '').trim();
    }
    const esAsesor = req.user.cargo === 'asesor';
    if (esAsesor) {
      const [ventasCRM] = await db.query(`
        SELECT v.estado, v.estado_grab, v.created_at AS venta_created_at,
               cv.estado_validacion, cv.fecha_validacion, fechas.fecha_grabacion, fechas.fecha_seguimiento
        FROM ventas v
        LEFT JOIN (
          SELECT vh.venta_id, vh.valor_nuevo AS estado_validacion, vh.created_at AS fecha_validacion
          FROM venta_historial vh
          INNER JOIN (SELECT venta_id, MAX(id) max_id FROM venta_historial WHERE campo='estado' AND tipo='CAMBIO_VALIDACION' GROUP BY venta_id) ult ON ult.max_id=vh.id
        ) cv ON cv.venta_id=v.id
        LEFT JOIN (
          SELECT venta_id,
                 MAX(CASE WHEN campo='estado_grab' THEN created_at END) fecha_grabacion,
                 MAX(CASE WHEN modulo='Seguimiento' AND campo IN ('estado','motivo_seguimiento','tramo_seguimiento') THEN created_at END) fecha_seguimiento
          FROM venta_historial GROUP BY venta_id
        ) fechas ON fechas.venta_id=v.id
        WHERE TRIM(v.telefono1)=TRIM(?) ORDER BY v.id DESC LIMIT 1
      `, [lead.n1 || '']);
      // VENTA CAIDA no bloquea: el asesor puede volver a tipificar (p.ej. si
      // recupera la venta), igual que ya se permite al rotar este numero.
      const tipifInternaActual = tipificacionInternaVenta(ventasCRM[0]);
      if (tipifInternaActual && tipifInternaActual.tipificacion !== 'VENTA CAIDA' && !cicloTipif) {
        return res.status(409).json({ ok:false, mensaje:'Este lead tiene una tipificacion interna exclusiva actualizada por el CRM' });
      }
    }
    if (esAsesor && String(tipif_vend || '').trim().toUpperCase() === 'INSTALADO')
      return res.status(403).json({ ok: false, mensaje: 'La tipificación INSTALADO es exclusiva de Back Data' });
    // Obtener nombre propio antes del check para cubrir el caso asesor_id=null pero asesor_nombre coincide.
    let miNombre = '';
    if (esAsesor) {
      const [me] = await db.query(`SELECT nombre FROM usuarios WHERE id = ? LIMIT 1`, [req.user.id]);
      miNombre = (me[0]?.nombre || '').trim();
    }
    const esActual = Number(lead.asesor_id) === Number(req.user.id)
      || (esAsesor && !!miNombre && String(lead.asesor_nombre || '').trim() === miNombre);
    let historial = [];
    try { historial = JSON.parse(lead.historial || '[]'); } catch { historial = []; }

    // Titular actual, o cargos de gestión (backoffice, etc.): actualiza la tipif vigente
    // del titular + registra el evento (con ts) a nombre del titular actual.
    if (!esAsesor || esActual) {
      registrarTipifEvent(historial, lead.asesor_nombre || '', tipifNormalizada, { ...datosCicloTipif, ...(documentoTexto ? { documento:documentoTexto } : {}) });
      await db.query(`UPDATE leads SET tipif_vend=?, tipif_hora=?, historial=?, obs_asesor=IF(?, ?, obs_asesor), distrito_sin_cobertura=IF(?='SIN COBERTURA',?,distrito_sin_cobertura), coordenadas_sin_cobertura=IF(?='SIN COBERTURA',?,coordenadas_sin_cobertura) WHERE id=?`,
        [tipifNormalizada, horaPeruAhora(), JSON.stringify(historial), documentoTexto !== '' || tipifNormalizada === 'SIN COBERTURA', obsFinal, tipifNormalizada, distrito||'', tipifNormalizada, coordenadas||'', req.params.id]);
      if (!lead.lead_origen_id && esTipificacionOrigen(tipifNormalizada)) await bloquearOtrasCampanasDelDia(db, lead);
      return res.json({ ok: true, mensaje: 'Tipificación guardada' });
    }

    // Asesor que YA no es el titular: puede ACTUALIZAR su propia tipificación (p.ej.
    // recontactó al cliente). Actualiza su registro en el historial y su evento con ts,
    // para que la base tome la más reciente. No toca la tipif del titular actual.
    // miNombre ya fue obtenido arriba.

    // CASO B: asesor_id nulo/inválido pero soy el asesor actual según la última asignación real del historial.
    // Ocurre cuando el lead fue creado/importado con un nombre que no resolvió a un id en BD.
    if (!lead.asesor_id || Number(lead.asesor_id) === 0) {
      let ultimaAsig = null;
      for (let i = historial.length - 1; i >= 0; i--) {
        const h = historial[i];
        if (h && h.tipo !== 'TIPIF_BACK' && h.tipo !== 'DERIVADO' && h.tipo !== 'TIPIF_VEND') { ultimaAsig = h; break; }
      }
      if (ultimaAsig && (ultimaAsig.asesor || '').trim() === miNombre) {
        registrarTipifEvent(historial, miNombre, tipifNormalizada, { ...datosCicloTipif, ...(documentoTexto ? { documento:documentoTexto } : {}) });
        await db.query(`UPDATE leads SET tipif_vend=?, tipif_hora=?, historial=?, obs_asesor=IF(?, ?, obs_asesor), distrito_sin_cobertura=IF(?='SIN COBERTURA',?,distrito_sin_cobertura), coordenadas_sin_cobertura=IF(?='SIN COBERTURA',?,coordenadas_sin_cobertura) WHERE id=?`,
          [tipifNormalizada, horaPeruAhora(), JSON.stringify(historial), documentoTexto !== '' || tipifNormalizada === 'SIN COBERTURA', obsFinal, tipifNormalizada, distrito||'', tipifNormalizada, coordenadas||'', req.params.id]);
        if (!lead.lead_origen_id && esTipificacionOrigen(tipifNormalizada)) await bloquearOtrasCampanasDelDia(db, lead);
        return res.json({ ok: true, mensaje: 'Tipificación guardada' });
      }
    }

    let idx = -1;
    for (let i = historial.length - 1; i >= 0; i--) {
      if ((historial[i]?.asesorAnterior || '').trim() === miNombre) { idx = i; break; }
    }
    if (idx < 0) return res.status(403).json({ ok: false, mensaje: 'No puedes tipificar leads de otros asesores' });
    const previa = String(historial[idx].tipifVendAntes || '').toUpperCase();
    if (['NO TOCAR','FRAUDE','INSTALADO'].includes(previa))
      return res.status(409).json({ ok: false, mensaje: `Tu tipificación está protegida (${previa}) y no se puede cambiar` });
    // El asesor previo SÍ puede finalizar (VENTA CERRADA / SIN COBERTURA) si recontactó
    // al cliente; la base tomará esa como la más reciente.
    historial[idx].tipifVendAntes = tipifNormalizada;
    if (documentoTexto) historial[idx].documento = documentoTexto;
    registrarTipifEvent(historial, miNombre, tipifNormalizada, { ...datosCicloTipif, ...(documentoTexto ? { documento:documentoTexto } : {}) });
    await db.query(`UPDATE leads SET historial=?, obs_asesor=IF(?, ?, obs_asesor), distrito_sin_cobertura=IF(?='SIN COBERTURA',?,distrito_sin_cobertura), coordenadas_sin_cobertura=IF(?='SIN COBERTURA',?,coordenadas_sin_cobertura) WHERE id=?`,
      [JSON.stringify(historial), documentoTexto !== '' || tipifNormalizada === 'SIN COBERTURA', obsFinal, tipifNormalizada, distrito||'', tipifNormalizada, coordenadas||'', req.params.id]);
    if (!lead.lead_origen_id && esTipificacionOrigen(tipifNormalizada)) await bloquearOtrasCampanasDelDia(db, lead);
    res.json({ ok: true, mensaje: 'Tu tipificación fue actualizada' });
  } catch(e) {
    res.status(500).json({ ok: false, mensaje: 'Error al guardar tipificación' });
  }
});

// PATCH /api/leads/:id/obs
router.patch('/:id/obs', auth(ROLES_ALL), async (req, res) => {
  try {
    const { obs } = req.body;
    if (obs && String(obs).length > 2000)
      return res.status(400).json({ ok: false, mensaje: 'obs_asesor no puede superar 2000 caracteres' });
    const [rows] = await db.query(`SELECT id, asesor_id, asesor_nombre, historial FROM leads WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, mensaje: 'Lead no encontrado' });
    // La observación global pertenece a la asignación vigente. Si un asesor anterior
    // modifica SU comentario, se actualiza exclusivamente su tramo del historial.
    if (req.user.cargo === 'asesor' && Number(rows[0].asesor_id) !== Number(req.user.id)) {
      const [me] = await db.query(`SELECT nombre FROM usuarios WHERE id = ? LIMIT 1`, [req.user.id]);
      const miNombre = String(me[0]?.nombre || '').trim();
      let historial = [];
      try { historial = JSON.parse(rows[0].historial || '[]'); } catch { historial = []; }
      let idx = -1;
      for (let i = historial.length - 1; i >= 0; i--) {
        if (String(historial[i]?.asesorAnterior || '').trim() === miNombre) { idx = i; break; }
      }
      if (idx < 0) return res.status(403).json({ ok: false, mensaje: 'No puedes modificar observaciones de otros asesores' });
      historial[idx] = { ...historial[idx], obsAsesorAntes:String(obs || '') };
      await db.query(`UPDATE leads SET historial=? WHERE id=?`, [JSON.stringify(historial), req.params.id]);
      return res.json({ ok: true, mensaje: 'Observación personal guardada' });
    }
    let historial = [];
    try { historial = JSON.parse(rows[0].historial || '[]'); } catch { historial = []; }
    const [me] = await db.query(`SELECT nombre FROM usuarios WHERE id = ? LIMIT 1`, [req.user.id]);
    const nombreActor = String(me[0]?.nombre || rows[0].asesor_nombre || '').trim();
    if (nombreActor) {
      for (let i = historial.length - 1; i >= 0; i--) {
        const h = historial[i];
        if (h?.asesor && h.tipo !== 'TIPIF_VEND' && String(h.asesor).trim() === nombreActor) {
          historial[i] = { ...h, obsAsesorPersonal:String(obs || '') };
          break;
        }
      }
    }

    await db.query(`UPDATE leads SET obs_asesor=?, historial=? WHERE id=?`, [obs||'', JSON.stringify(historial), req.params.id]);
    res.json({ ok: true, mensaje: 'Observacion guardada' });
  } catch(e) {
    res.status(500).json({ ok: false, mensaje: 'Error al guardar observación' });
  }
});

// PATCH /api/leads/:id/eliminar-asignacion
// Elimina una asignación individual del historial (identificada por asesor+hora+fecha).
// El número desaparece de la base del asesor eliminado. Si era el titular actual, vuelve
// al asesor anterior (con la tipificación que dejó) o queda sin asignar si no hay anterior.
router.patch('/:id/eliminar-asignacion', auth(ROLES_BO), async (req, res) => {
  let conn;
  try {
    const { asesor, hora, fecha } = req.body;
    if (!asesor?.trim()) return res.status(400).json({ ok: false, mensaje: 'Falta el asesor de la asignación' });

    conn = await db.getConnection();
    await conn.beginTransaction();

    const [leads] = await conn.query(`SELECT * FROM leads WHERE id = ? FOR UPDATE`, [req.params.id]);
    if (!leads.length) { await conn.rollback(); return res.status(404).json({ ok: false, mensaje: 'Lead no encontrado' }); }
    const lead = leads[0];

    let historial = [];
    try { historial = JSON.parse(lead.historial || '[]'); } catch { historial = []; }

    // Localiza la asignación a eliminar (ignora entradas que no son asignaciones).
    const idx = historial.findIndex(h =>
      h && normalizarNombreAsesor(h.asesor) === normalizarNombreAsesor(asesor)
      && (h.hora || '') === (hora || '') && (h.fecha || '') === (fecha || '')
      && !['TIPIF_BACK','DERIVADO','TIPIF_VEND','QUITAR_ASIGNACION']
        .includes(String(h.tipo || '').trim().toUpperCase()));
    if (idx < 0) { await conn.rollback(); return res.status(404).json({ ok: false, mensaje: 'Asignación no encontrada' }); }

    const eliminado = historial[idx];
    const nuevoHist = historial.filter((_, i) => i !== idx);
    const eraActual = normalizarNombreAsesor(lead.asesor_nombre) === normalizarNombreAsesor(eliminado.asesor);

    const [actores] = await conn.query(`SELECT nombre, cargo FROM usuarios WHERE id = ? LIMIT 1`, [req.user.id]);
    const actor = actores[0] || {};
    nuevoHist.push({
      tipo: 'QUITAR_ASIGNACION', asesorQuitado: eliminado.asesor || '',
      quitadoPor: actor.nombre || req.user.nombre || 'Usuario',
      cargoQuitadoPor: actor.cargo || req.user.cargo || '',
      hora: horaPeruAhora(), fecha: fechaPeruHoy(), ts: Date.now(), eraActual,
    });

    const rotacionesReales = contarRotacionesHistorial(nuevoHist);
    if (eraActual) {
      const asignaciones = asignacionesVigentesHistorial(nuevoHist);
      const previo = asignaciones[asignaciones.length - 1];
      if (previo) {
        const [u] = await conn.query(`SELECT id, nombre FROM usuarios WHERE nombre = ? LIMIT 1`, [previo.asesor]);
        const asesorId = u.length ? u[0].id : null;
        // La tipificación del asesor previo quedó registrada como tipifVendAntes en la
        // entrada que lo rotó hacia el asesor eliminado.
        const tipifPrevio = eliminado.tipifVendAntes != null ? String(eliminado.tipifVendAntes) : '';
        await conn.query(
          `UPDATE leads SET asesor_id=?, asesor_nombre=?, sin_asignar=0, tipif_vend=?, tipif_hora='', historial=?, rotaciones=? WHERE id=?`,
          [asesorId, previo.asesor, tipifPrevio, JSON.stringify(nuevoHist), rotacionesReales, req.params.id]);
      } else {
        await conn.query(
          `UPDATE leads SET asesor_id=NULL, asesor_nombre='', sin_asignar=1, tipif_vend='', tipif_hora='', historial=?, rotaciones=? WHERE id=?`,
          [JSON.stringify(nuevoHist), rotacionesReales, req.params.id]);
      }
    } else {
      await conn.query(`UPDATE leads SET historial=?, rotaciones=? WHERE id=?`, [JSON.stringify(nuevoHist), rotacionesReales, req.params.id]);
    }

    // Auditoría para Jefatura/Gerencia: registra quién quitó qué asignación.
    await conn.query(
      `INSERT INTO eliminaciones
        (actor_id, actor_nombre, actor_cargo, tipo, registro_id, detalle, snapshot_json)
       VALUES (?, ?, ?, 'ASIGNACION_BACKDATA', ?, ?, ?)`,
      [req.user.id, actor.nombre || 'Usuario', actor.cargo || req.user.cargo || '', String(req.params.id),
        `Quitó asignación de ${eliminado.asesor || '—'} · N1 ${lead.n1 || '—'} · ${eraActual ? 'era titular actual' : 'asesor anterior'}`,
        JSON.stringify({ entradaEliminada: eliminado, leadN1: lead.n1, leadFecha: lead.fecha })]
    );

    await conn.commit();
    const [after] = await conn.query(`SELECT historial, asesor_nombre, tipif_vend, rotaciones FROM leads WHERE id = ?`, [req.params.id]);
    let histOut = [];
    try { histOut = JSON.parse(after[0].historial || '[]'); } catch { histOut = []; }
    res.json({ ok: true, historial: histOut, asesor: after[0].asesor_nombre || '', tipif_vend: after[0].tipif_vend || '', rotaciones:Number(after[0].rotaciones || 0) });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al eliminar la asignación' });
  } finally {
    if (conn) conn.release();
  }
});

// DELETE /api/leads/:id
router.delete('/:id', auth(ROLES_BO), async (req, res) => {
  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();
    const [rows] = await conn.query(`
      SELECT l.*, u.nombre AS asesor_nombre_db
      FROM leads l LEFT JOIN usuarios u ON u.id = l.asesor_id
      WHERE l.id = ? FOR UPDATE
    `, [req.params.id]);
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ ok: false, mensaje: 'Lead no encontrado' });
    }
    const [actores] = await conn.query(`SELECT nombre, cargo FROM usuarios WHERE id = ? LIMIT 1`, [req.user.id]);
    const lead = rows[0];
    const actor = actores[0] || {};
    // Un teléfono real no puede desaparecer por una acción operativa de Back
    // Data. Las limpiezas de registros válidos quedan reservadas a Jefatura;
    // Back Data conserva la posibilidad de retirar filas vacías o corruptas.
    // req.user.cargo puede ser el del usuario IMPERSONADO cuando Jefatura entra
    // vía "Vista de" (ver middleware/auth.js) — ahí req.actor conserva el cargo
    // real de quien está autenticado, y también debe contar como Jefatura.
    const esJefaturaReal = req.user.cargo === 'jefatura' || req.actor?.cargo === 'jefatura';
    const n1Normalizado = normalizarN1(lead.n1);
    if (n1Normalizado.length >= 8 && !esJefaturaReal) {
      await conn.rollback();
      return res.status(403).json({
        ok: false,
        mensaje: 'Número protegido: solo Jefatura puede eliminar un teléfono válido. El registro permanece en KRONO.',
      });
    }
    await conn.query(`DELETE FROM leads WHERE id = ?`, [req.params.id]);
    await conn.query(
      `INSERT INTO eliminaciones
        (actor_id, actor_nombre, actor_cargo, tipo, registro_id, detalle, snapshot_json)
       VALUES (?, ?, ?, 'NUMERO_BACKDATA', ?, ?, ?)`,
      [req.user.id, actor.nombre || 'Usuario', actor.cargo || req.user.cargo || '', String(req.params.id),
        `N1 ${lead.n1 || '—'} · N2 ${lead.n2 || '—'} · Asesor ${lead.asesor_nombre_db || lead.asesor_nombre || 'Sin asignar'} · Fecha ${lead.fecha || '—'}`,
        JSON.stringify(lead)]
    );
    await conn.commit();
    res.json({ ok: true, mensaje: 'Lead eliminado' });
  } catch(e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al eliminar lead' });
  } finally {
    conn?.release();
  }
});

// DELETE /api/leads/fecha/:fecha
router.delete('/fecha/:fecha', auth(['jefatura']), async (req, res) => {
  let conn;
  try {
    conn = await db.getConnection();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.fecha))
      return res.status(400).json({ ok: false, mensaje: 'Formato de fecha inválido. Usa YYYY-MM-DD' });

    await conn.beginTransaction();
    const [leads] = await conn.query(`
      SELECT l.*, u.nombre AS asesor_nombre_db
      FROM leads l LEFT JOIN usuarios u ON u.id = l.asesor_id
      WHERE l.fecha = ? FOR UPDATE
    `, [req.params.fecha]);
    const [actores] = await conn.query(`SELECT nombre, cargo FROM usuarios WHERE id = ? LIMIT 1`, [req.user.id]);
    const actor = actores[0] || {};
    const [result] = await conn.query(`DELETE FROM leads WHERE fecha = ?`, [req.params.fecha]);
    for (const lead of leads) {
      await conn.query(
        `INSERT INTO eliminaciones
          (actor_id, actor_nombre, actor_cargo, tipo, registro_id, detalle, snapshot_json)
         VALUES (?, ?, ?, 'NUMERO_BACKDATA', ?, ?, ?)`,
        [req.user.id, actor.nombre || 'Usuario', actor.cargo || req.user.cargo || '', String(lead.id),
          `N1 ${lead.n1 || '—'} · N2 ${lead.n2 || '—'} · Asesor ${lead.asesor_nombre_db || lead.asesor_nombre || 'Sin asignar'} · Fecha ${lead.fecha || '—'}`,
          JSON.stringify(lead)]
      );
    }
    await conn.commit();
    res.json({ ok: true, eliminados: result.affectedRows });
  } catch(e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al eliminar leads' });
  } finally {
    conn?.release();
  }
});

// GET /api/leads/fecha-peru
router.get('/fecha-peru', auth(ROLES_ALL), (req, res) => {
  res.json({ ok: true, fecha: fechaPeruHoy(), hora: horaPeruAhora() });
});

// ===== Envío masivo (exclusivo Jefatura) =====
// Arma lotes de números para copiar y pegar en una plataforma externa de
// envío masivo. Excluye leads ya tipificados SIN COBERTURA / VENTA CERRADA
// (no tiene sentido volver a contactarlos). Deja un registro interno
// (leads_masivo_lotes + leads.masivo_lote_id) para diferenciar qué leads ya
// entraron a un envío masivo anterior.
let promesaTablaMasivo;
function asegurarTablaMasivo() {
  if (!promesaTablaMasivo) {
    promesaTablaMasivo = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS leads_masivo_lotes (
          id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          cantidad INT NOT NULL,
          creado_por_id INT NULL,
          creado_por_nombre VARCHAR(150) NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      const [columnas] = await db.query('SHOW COLUMNS FROM leads');
      const existentes = new Set(columnas.map(columna => columna.Field));
      const nuevas = [
        ['masivo_lote_id', 'INT NULL'],
        ['masivo_fecha', 'DATETIME NULL'],
      ];
      for (const [columna, definicion] of nuevas) {
        if (!existentes.has(columna)) await db.query(`ALTER TABLE leads ADD COLUMN ${columna} ${definicion}`);
      }
    })().catch(error => { promesaTablaMasivo = null; throw error; });
  }
  return promesaTablaMasivo;
}

router.get('/masivo-elegibles', auth(['jefatura']), async (req, res) => {
  try {
    await asegurarTablaMasivo();
    const { campana, distrito, desde, hasta } = req.query;
    const condiciones = [
      'l.lead_origen_id IS NULL',
      `UPPER(TRIM(COALESCE(l.tipif_vend, ''))) NOT IN ('SIN COBERTURA', 'VENTA CERRADA')`,
    ];
    const params = [];
    if (campana) { condiciones.push('l.campana = ?'); params.push(campana); }
    if (distrito) { condiciones.push('l.distrito = ?'); params.push(distrito); }
    if (desde) { condiciones.push('l.fecha >= ?'); params.push(desde); }
    if (hasta) { condiciones.push('l.fecha <= ?'); params.push(hasta); }
    const [data] = await db.query(`
      SELECT l.id, l.n1, l.n2, l.usuario_whatsapp, l.campana, l.distrito, l.asesor_nombre, l.fecha,
             l.tipif_vend, l.masivo_lote_id, l.masivo_fecha
        FROM leads l
       WHERE ${condiciones.join(' AND ')}
       ORDER BY l.fecha DESC, l.id DESC
       LIMIT 5000
    `, params);
    const [catalogos] = await db.query(`
      SELECT DISTINCT l.campana, l.tipif_vend FROM leads l
       WHERE l.lead_origen_id IS NULL
         AND UPPER(TRIM(COALESCE(l.tipif_vend, ''))) NOT IN ('SIN COBERTURA', 'VENTA CERRADA')
    `);
    const campanas = [...new Set(catalogos.map(c => c.campana).filter(Boolean))].sort();
    const tipificaciones = [...new Set(catalogos.map(c => (c.tipif_vend && c.tipif_vend.trim()) || 'SIN TIPIFICAR'))].sort();
    res.json({ ok: true, data, filtros: { campanas, tipificaciones } });
  } catch (e) {
    console.error('[GET /leads/masivo-elegibles]', e.message || e);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener leads elegibles para envío masivo' });
  }
});

router.post('/masivo-lote', auth(['jefatura']), async (req, res) => {
  try {
    await asegurarTablaMasivo();
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(id => Number.isInteger(id) && id > 0) : [];
    if (!ids.length) return res.status(400).json({ ok: false, mensaje: 'No se seleccionó ningún lead' });
    const [resultado] = await db.query(
      'INSERT INTO leads_masivo_lotes (cantidad, creado_por_id, creado_por_nombre) VALUES (?, ?, ?)',
      [ids.length, req.user.id, req.user.nombre || req.user.usuario || 'Jefatura']
    );
    const loteId = resultado.insertId;
    await db.query(
      `UPDATE leads SET masivo_lote_id = ?, masivo_fecha = NOW() WHERE id IN (${ids.map(() => '?').join(',')})`,
      [loteId, ...ids]
    );
    res.json({ ok: true, lote_id: loteId, cantidad: ids.length });
  } catch (e) {
    console.error('[POST /leads/masivo-lote]', e.message || e);
    res.status(500).json({ ok: false, mensaje: 'Error al registrar el lote de envío masivo' });
  }
});

// ===== Costos publicitarios por campaña (Jefatura / Marketing) =====
// Registro manual de cuanto se gasto en publicidad, por dia y por campana,
// para poder calcular costo por lead (CPL) y costo por venta (CPV) cruzando
// contra los totales que ya expone GET /leads/marketing-resumen. Un gasto
// por (fecha, campana): volver a registrar el mismo dia/campana actualiza
// el monto (upsert) en vez de duplicar.
let promesaTablaMarketingGastos;
function asegurarTablaMarketingGastos() {
  if (!promesaTablaMarketingGastos) {
    promesaTablaMarketingGastos = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS marketing_gastos (
          id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          fecha DATE NOT NULL,
          campana VARCHAR(100) NOT NULL,
          tipo VARCHAR(20) NOT NULL DEFAULT 'ventas',
          monto DECIMAL(10,2) NOT NULL,
          notas VARCHAR(255) NULL,
          registrado_por_id INT NULL,
          registrado_por_nombre VARCHAR(150) NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_marketing_gasto_fecha_campana_tipo (fecha, campana, tipo)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      // Migracion para instalaciones donde la tabla ya existia sin `tipo`
      // (distingue campañas de Ventas vs Reclutamiento, que son catálogos
      // independientes y pueden repetir nombre de campaña).
      const [columnas] = await db.query('SHOW COLUMNS FROM marketing_gastos');
      if (!columnas.some(c => c.Field === 'tipo')) {
        await db.query("ALTER TABLE marketing_gastos ADD COLUMN tipo VARCHAR(20) NOT NULL DEFAULT 'ventas' AFTER campana");
        const [indices] = await db.query('SHOW INDEX FROM marketing_gastos');
        if (indices.some(i => i.Key_name === 'uniq_marketing_gasto_fecha_campana')) {
          await db.query('ALTER TABLE marketing_gastos DROP INDEX uniq_marketing_gasto_fecha_campana');
        }
        if (!indices.some(i => i.Key_name === 'uniq_marketing_gasto_fecha_campana_tipo')) {
          await db.query('ALTER TABLE marketing_gastos ADD UNIQUE KEY uniq_marketing_gasto_fecha_campana_tipo (fecha, campana, tipo)');
        }
      }
    })().catch(error => { promesaTablaMarketingGastos = null; throw error; });
  }
  return promesaTablaMarketingGastos;
}

const TIPOS_GASTO_VALIDOS = ['ventas', 'reclutamiento'];

router.get('/marketing-gastos', auth(['jefatura', 'marketing']), async (req, res) => {
  try {
    await asegurarTablaMarketingGastos();
    const desde = String(req.query.desde || '').trim();
    const hasta = String(req.query.hasta || '').trim();
    const tipo = TIPOS_GASTO_VALIDOS.includes(req.query.tipo) ? req.query.tipo : 'ventas';
    const errores = validar([
      errorFecha(desde || undefined, 'desde'),
      errorFecha(hasta || undefined, 'hasta'),
    ]);
    if (errores) return res.status(400).json({ ok: false, mensaje: errores[0] });
    if (desde && hasta && desde > hasta)
      return res.status(400).json({ ok: false, mensaje: 'La fecha Desde no puede ser posterior a Hasta' });
    const condiciones = ['tipo = ?'];
    const params = [tipo];
    if (desde) { condiciones.push('fecha >= ?'); params.push(desde); }
    if (hasta) { condiciones.push('fecha <= ?'); params.push(hasta); }
    const where = `WHERE ${condiciones.join(' AND ')}`;
    const [data] = await db.query(
      `SELECT id, fecha, campana, monto, notas, registrado_por_nombre
         FROM marketing_gastos ${where}
        ORDER BY fecha DESC, id DESC`,
      params
    );
    const total = data.reduce((acc, fila) => acc + Number(fila.monto || 0), 0);
    res.json({ ok: true, data, total });
  } catch (e) {
    console.error('[GET /leads/marketing-gastos]', e.message || e);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener los gastos publicitarios' });
  }
});

router.post('/marketing-gastos', auth(['jefatura', 'marketing']), async (req, res) => {
  try {
    await asegurarTablaMarketingGastos();
    const fecha = String(req.body?.fecha || '').trim();
    const campana = String(req.body?.campana || '').trim();
    const notas = String(req.body?.notas || '').trim();
    const monto = Number(req.body?.monto);
    const tipo = TIPOS_GASTO_VALIDOS.includes(req.body?.tipo) ? req.body.tipo : 'ventas';
    const errores = validar([
      errorFecha(fecha, 'fecha'),
      errorTexto(campana, 'campana', { requerido: true, max: 100 }),
      errorTexto(notas, 'notas', { max: 255 }),
    ]);
    if (errores) return res.status(400).json({ ok: false, mensaje: errores[0] });
    if (!Number.isFinite(monto) || monto <= 0)
      return res.status(400).json({ ok: false, mensaje: 'El monto debe ser un número mayor a 0' });
    await db.query(
      `INSERT INTO marketing_gastos (fecha, campana, tipo, monto, notas, registrado_por_id, registrado_por_nombre)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE monto = VALUES(monto), notas = VALUES(notas),
         registrado_por_id = VALUES(registrado_por_id), registrado_por_nombre = VALUES(registrado_por_nombre)`,
      [fecha, campana, tipo, monto, notas || null, req.user.id, req.user.nombre || req.user.usuario || 'Jefatura']
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /leads/marketing-gastos]', e.message || e);
    res.status(500).json({ ok: false, mensaje: 'Error al registrar el gasto publicitario' });
  }
});

router.delete('/marketing-gastos/:id', auth(['jefatura', 'marketing']), async (req, res) => {
  try {
    await asegurarTablaMarketingGastos();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, mensaje: 'Id inválido' });
    await db.query('DELETE FROM marketing_gastos WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /leads/marketing-gastos/:id]', e.message || e);
    res.status(500).json({ ok: false, mensaje: 'Error al eliminar el gasto publicitario' });
  }
});

module.exports = router;
