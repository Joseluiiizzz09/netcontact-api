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

// Cada asignacion real a un asesor cuenta como una rotacion, incluida la
// asignacion inicial. Se excluyen carga, tipificaciones y eventos auxiliares.
function contarRotacionesHistorial(valor) {
  return historialArray(valor).filter(h => {
    const tipo = String(h?.tipo || '').trim().toUpperCase();
    return Boolean(String(h?.asesor || '').trim())
      && !['CARGA', 'TIPIF_VEND', 'TIPIF_BACK', 'DERIVADO'].includes(tipo);
  }).length;
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

function resumenSinCoberturaDia(lead, historial, fecha = fechaPeruHoy()) {
  const hist = historialArray(historial);
  const fechaLead = normalizarFechaAsignacion(lead?.fecha);
  const tuvoSinCobertura = (
    String(lead?.tipif_vend || '').trim().toUpperCase() === 'SIN COBERTURA'
    && fechaLead === fecha
  ) || hist.some(h => normalizarFechaAsignacion(h?.fecha) === fecha && [h?.tipif, h?.tipif_vend, h?.tipifVendAntes]
    .some(v => String(v || '').trim().toUpperCase() === 'SIN COBERTURA'));
  const rotaciones = hist.filter(h =>
    (String(h?.tipo || '').trim().toUpperCase() === 'ROTACION' || Boolean(h?.reasignadoPor))
    && normalizarFechaAsignacion(h?.fecha) === fecha
  ).length;
  return { aplica: tuvoSinCobertura, rotaciones };
}

async function existeTipificadoOtraCampana(conn, n1, fecha, campana, excluirId = null) {
  const params = [normalizarN1(n1), fecha, normalizarCampana(campana)];
  let excluirSql = '';
  if (excluirId) { excluirSql = ' AND id <> ?'; params.push(excluirId); }
  const [rows] = await conn.query(`
    SELECT id, fecha, tipif_vend, historial
    FROM leads
    WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(n1, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', '') = ?
      AND fecha = ?
      AND UPPER(TRIM(campana)) <> UPPER(TRIM(?))${excluirSql}
  `, params);
  return rows.some(r => resumenTipificadoDia(r, r.historial, fecha).aplica);
}

async function idLeadMasAntiguoDelDia(conn, n1, fecha) {
  const numero = normalizarN1(n1);
  if (!numero || !fecha) return null;
  const [rows] = await conn.query(`
    SELECT id FROM leads
    WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(n1, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', '') = ?
      AND fecha = ?
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `, [numero, fecha]);
  return rows[0]?.id || null;
}

async function bloquearOtrasCampanasDelDia(conn, lead) {
  const n1 = normalizarN1(lead?.n1);
  const fecha = normalizarFechaAsignacion(lead?.fecha) || fechaPeruHoy();
  if (!n1 || !fecha) return;
  let creadoEn = lead?.created_at || null;
  if (!creadoEn && lead?.id) {
    const [origen] = await conn.query(`SELECT created_at FROM leads WHERE id=? LIMIT 1`, [lead.id]);
    creadoEn = origen[0]?.created_at || null;
  }
  await conn.query(`
    UPDATE leads
    SET tipif_vend = 'NO ROTAR', tipif_hora = ?
    WHERE id <> ?
      AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(n1, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', '') = ?
      AND fecha = ?
      AND UPPER(TRIM(campana)) <> UPPER(TRIM(?))
      AND UPPER(TRIM(COALESCE(tipif_vend,''))) NOT IN ('VENTA CERRADA','NO TOCAR','SH NO TOCAR','NO ROTAR','SH NO ROTAR')
      AND (? IS NULL OR created_at > ?)
  `, [horaPeruAhora(), lead.id, n1, fecha, normalizarCampana(lead.campana), creadoEn, creadoEn]);
}

async function bloquearDuplicadosAlRotar(conn, lead) {
  const n1 = normalizarN1(lead?.n1);
  const fecha = normalizarFechaAsignacion(lead?.fecha);
  if (!n1 || !fecha) return;
  await conn.query(`
    UPDATE leads SET tipif_vend='NO ROTAR', tipif_hora=?
    WHERE id<>?
      AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(n1, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', '')=?
      AND fecha=?
      AND UPPER(TRIM(campana))<>UPPER(TRIM(?))
      AND UPPER(TRIM(COALESCE(tipif_vend,''))) NOT IN ('VENTA CERRADA','NO TOCAR','SH NO TOCAR','NO ROTAR','SH NO ROTAR')
  `, [horaPeruAhora(), lead.id, n1, fecha, normalizarCampana(lead.campana)]);
}

async function nombreUsuario(id) {
  const [rows] = await db.query(`SELECT nombre FROM usuarios WHERE id = ? LIMIT 1`, [id]);
  return rows[0]?.nombre || 'Usuario Back Data';
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

    const errGet = validar([errorFecha(fecha, 'fecha'), errorFecha(desde, 'desde'), errorFecha(hasta, 'hasta')]);
    if (errGet) return res.status(400).json({ ok: false, mensaje: errGet[0] });
    const numeroBusqueda = String(numero || '').replace(/\D/g, '').slice(0, 20);

    let sql = `SELECT l.*, u.nombre as asesor_nombre_db
      FROM leads l LEFT JOIN usuarios u ON l.asesor_id = u.id WHERE 1=1`;
    const params = [];
    let visorAsesorId = null;
    let visorAsesorNombre = '';

    // La búsqueda global se resuelve en MySQL y no descargando toda la base al
    // navegador. Para teléfonos completos conserva búsquedas indexables.
    if (numeroBusqueda) {
      if (numeroBusqueda.length >= 7) {
        sql += ` AND (l.n1 = ? OR l.n2 = ?)`;
        params.push(numeroBusqueda, numeroBusqueda);
      } else {
        sql += ` AND (l.n1 LIKE ? OR l.n2 LIKE ?)`;
        params.push(`%${numeroBusqueda}%`, `%${numeroBusqueda}%`);
      }
    }
    if (desde) { sql += ` AND l.fecha >= ?`; params.push(desde); }
    if (hasta) { sql += ` AND l.fecha <= ?`; params.push(hasta); }

    if (cargoEfectivo === 'asesor') {
      // Base del asesor: leads asignados AHORA a él + los que trabajó antes
      // (su nombre aparece en el historial). Así un número no desaparece de su
      // base al ser rotado a otro asesor; conserva su registro de lo trabajado.
      const [uNom] = await db.query(`SELECT nombre FROM usuarios WHERE id = ? LIMIT 1`, [req.user.id]);
      const nom = uNom[0]?.nombre || '';
      visorAsesorId = req.user.id;
      visorAsesorNombre = nom;
      // El nombre debe figurar como ASESOR titular de alguna asignación ("asesor":"nom"),
      // no como asesorAnterior/rotadoPor. Así, al quitar su asignación desaparece de su base.
      sql += ` AND (l.asesor_id = ? OR l.historial LIKE CONCAT('%\"asesor\":\"', ?, '\"%'))`;
      params.push(req.user.id, nom);
      // Si el número ya produjo una venta, queda visible para quien la registró
      // o para el titular actual. Esto permite que una VENTA CAIDA rotada llegue
      // como NUEVO al vendedor que debe intentar cerrarla nuevamente.
      sql += ` AND (
        l.asesor_id = ?
        OR NOT EXISTS (SELECT 1 FROM ventas v WHERE TRIM(v.telefono1) = TRIM(l.n1))
        OR EXISTS (SELECT 1 FROM ventas v WHERE TRIM(v.telefono1) = TRIM(l.n1) AND v.asesor_id = ?)
      )`;
      params.push(req.user.id, req.user.id);
    } else if (asesor_id) {
      const [uNom] = await db.query(`SELECT nombre, cargo FROM usuarios WHERE id = ? LIMIT 1`, [asesor_id]);
      const nom = uNom[0]?.nombre || '';
      // Jefatura también puede abrir la vista de un usuario de Back Data. Ese
      // usuario administra la base completa y no debe tratarse como asesor
      // asignado, porque hacerlo deja la jornada artificialmente en cero.
      if (String(uNom[0]?.cargo || '').trim().toLowerCase() === 'asesor') {
        visorAsesorId = Number(asesor_id);
        visorAsesorNombre = nom;
        sql += ` AND (l.asesor_id = ? OR l.historial LIKE CONCAT('%"asesor":"', ?, '"%'))`;
        params.push(asesor_id, nom);
        sql += ` AND (
          l.asesor_id = ?
          OR NOT EXISTS (SELECT 1 FROM ventas v WHERE TRIM(v.telefono1) = TRIM(l.n1))
          OR EXISTS (SELECT 1 FROM ventas v WHERE TRIM(v.telefono1) = TRIM(l.n1) AND v.asesor_id = ?)
        )`;
        params.push(asesor_id, asesor_id);
      }
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
    if (data.length > 0) {
      const phones = [...new Set(data.map(l => (l.n1 || '').trim()).filter(Boolean))];
      if (phones.length > 0) {
        const placeholders = phones.map(() => '?').join(',');
        const [ventas] = await db.query(
          `SELECT v.id, v.telefono1, v.asesor_id, u.nombre AS asesor_nombre,
                  v.dni AS venta_documento, v.tipo_doc AS venta_tipo_doc,
                  v.estado, v.estado_grab, v.motivo_seguimiento, v.created_at AS venta_created_at
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

    const salida = data.map(l => {
      const historial = (() => { try { return JSON.parse(l.historial||'[]'); } catch(e){ return []; } })();
      const rotacionesReales = contarRotacionesHistorial(historial);
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
      const ventaCerrada = ventaConfirmada === 1 && ventaAsesorId && tipifInterna?.tipificacion !== 'VENTA CAIDA';
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
        tipif_vend: normalizarTipifVendLegacy(l.tipif_vend),
        rotaciones: rotacionesReales,
        venta_confirmada: ventaConfirmada,
        venta_asesor_id: ventaAsesorId,
        venta_asesor_nombre: ventaAsesorNombre,
        venta_documento: ventaInfo?.venta_documento || '',
        venta_tipo_doc: ventaInfo?.venta_tipo_doc || '',
        tipif_interna: tipifInterna?.tipificacion || '',
        tipif_interna_color: tipifInterna?.color || '',
        tipif_interna_area: tipifInterna?.area || '',
        tipif_interna_fecha: tipifInterna?.fecha || '',
        tipif_interna_motivo: tipifInterna?.motivo || '',
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
      const clave = `${normalizarN1(lead.n1)}|${normalizarFechaAsignacion(lead.fecha)}`;
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
    res.json({ ok: true, data: dataFiltrada });
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
       AND n1 NOT IN (
         SELECT COALESCE(TRIM(telefono1),'') FROM ventas
         WHERE telefono1 IS NOT NULL AND TRIM(telefono1) != ''
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
// Resumen agregado y exclusivo de Jefatura para trasladar resultados a Marketing.
router.get('/marketing-resumen', auth(['jefatura']), async (req, res) => {
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
    const tipifSql = `COALESCE(NULLIF(TRIM(l.tipif_vend),''), NULLIF(TRIM(l.tipif_back_2),''), NULLIF(TRIM(l.tipif_back),''), 'SIN TIPIFICAR')`;
    const condiciones = [];
    const params = [];
    if (desde) { condiciones.push('DATE(l.created_at) >= ?'); params.push(desde); }
    if (hasta) { condiciones.push('DATE(l.created_at) <= ?'); params.push(hasta); }
    if (campana) { condiciones.push(`${campanaSql} = ?`); params.push(normalizarCampana(campana) || campana); }
    if (tipificacion) { condiciones.push(`${tipifSql} = ?`); params.push(tipificacion); }
    const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

    const [filas] = await db.query(`
      SELECT ${campanaSql} AS campana,
             ${tipifSql} AS tipificacion,
             COUNT(*) AS cantidad,
             MIN(l.created_at) AS primera_alta,
             MAX(l.created_at) AS ultima_alta
      FROM leads l
      ${where}
      GROUP BY ${campanaSql}, ${tipifSql}
      ORDER BY cantidad DESC, campana ASC, tipificacion ASC
    `, params);
    const [campanas] = await db.query(`SELECT DISTINCT ${campanaSql} campana FROM leads l ORDER BY campana`);
    const [tipificaciones] = await db.query(`SELECT DISTINCT ${tipifSql} tipificacion FROM leads l ORDER BY tipificacion`);
    res.json({
      ok:true,
      data:filas.map(f => ({ ...f, cantidad:Number(f.cantidad || 0) })),
      filtros:{
        campanas:campanas.map(f => f.campana),
        tipificaciones:tipificaciones.map(f => f.tipificacion),
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
        const hora       = String(l.hora       || '').trim().substring(0, 10);
        const obsAsesor  = String(l.comentario || '').trim().substring(0, 2000) || null;

        // Construir historial desde array de asesores
        const asesores = Array.isArray(l.asesores)
          ? l.asesores.map(a => String(a || '').trim()).filter(a => a.length > 1)
          : [];
        const lastAsesor = asesores.length ? asesores[asesores.length - 1] : '';

        const cargadoPorImport = await nombreUsuario(req.user.id);
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
          await conn.query(
            `INSERT INTO leads (campana, distrito, n1, n2, tipif_back, asesor_id, asesor_nombre, fecha, hora_asig, sin_asignar, tipif_vend, tipif_hora, historial, rotaciones, obs_asesor)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [campana, distrito, n1Raw, n2Clean, tipifBack, asesorId, asesorNombre, fechaLead, hora, sinAsignar, tipifVend, hora, JSON.stringify(historialArray), rotaciones, obsAsesor]
          );
          creados++;
          if (esTipificacionOrigen(tipifVend)) {
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
    const ids = [];
    const fechasUsadas = [];

    // Validar todas las fechas antes de insertar para evitar lotes parciales.
    for (const l of leads) {
      const fechaLead = l.fecha || fechaHoy;
      const errores = validar([
        errorFecha(fechaLead, 'fecha'),
        errorTexto(l.n1, 'n1', { requerido: true, max: 30 }),
        errorTexto(l.tipo_contacto, 'tipo_contacto', { max: 20 }),
        errorTexto(l.direccion, 'direccion', { max: 1000 }),
        errorTexto(l.coordenadas, 'coordenadas', { max: 255 }),
        errorTexto(l.obs_back, 'obs_back', { max: 2000 }),
      ]);
      if (errores) return res.status(400).json({ ok: false, mensaje: errores[0] });
    }

    for (const l of leads) {
      if (!l.n1) continue;
      const fechaLead = l.fecha || fechaHoy;
      const n1Normalizado = normalizarN1(l.n1);

      // El alta individual solicita esta comprobacion. La carga masiva conserva
      // su flujo de vista previa y su opcion explicita de incluir duplicados.
      if (l.verificar_duplicado && n1Normalizado) {
        const [duplicados] = await db.query(`
          SELECT id, n1, fecha
          FROM leads
          WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(n1, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', '') = ?
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

      let asesorId = l.asesor_id || null;
      let asesorNombre = '';

      if (asesorId) {
        // El nombre se obtiene de la BD, no del body
        const [uRows] = await db.query(`SELECT nombre FROM usuarios WHERE id = ?`, [asesorId]);
        if (uRows.length) asesorNombre = uRows[0].nombre;
        else asesorId = null;
      } else if (l.asesor_nombre || l.asesor) {
        const nombreBuscar = l.asesor_nombre || l.asesor;
        const [uRows] = await db.query(`SELECT id, nombre FROM usuarios WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?)) LIMIT 1`, [nombreBuscar]);
        if (uRows.length) { asesorId = uRows[0].id; asesorNombre = uRows[0].nombre; }
      }

      const horaFinal  = asesorId ? horaAhora : '';
      const tipifBackInicial = normalizarTipifBack(l.tipif_back);
      const campanaNormalizada = normalizarCampana(l.campana);
      const bloquearRotacion = Boolean(await idLeadMasAntiguoDelDia(db, n1Normalizado, fechaLead));
      const obsBackInicial = !tipifBackInicial ? '' : (tipifBackInicial === 'DERIVADO' ? 'DERIVADO' : 'LLAMAR AHORA');
      const nombreCargador = await nombreUsuario(req.user.id);
      const historial  = asesorId
        ? JSON.stringify([{ asesor: asesorNombre, hora: horaFinal, fecha: fechaLead, asignadoPor: nombreCargador, cargadoPor: nombreCargador, motivo: 'Asignacion inicial', obsBackPersonal:obsBackInicial, tipifBackOriginal:tipifBackInicial, tipifBackSlot:1 }])
        : JSON.stringify([{ tipo: 'CARGA', cargadoPor: nombreCargador, hora: horaPeruAhora(), fecha: fechaLead, motivo: 'Carga inicial' }]);

      const tipifBack = tipifBackInicial;
      const registraAutor = tipifBack === 'DERIVADO' || tipifBack === 'LLAMANDO';
      const derivadoPorNombre = registraAutor ? await nombreUsuario(req.user.id) : '';
      const [result] = await db.query(`
        INSERT INTO leads (campana, distrito, n1, n2, tipo_contacto, direccion, coordenadas, obs_back, tipif_back, derivado_por_id, derivado_por_nombre, asesor_id, asesor_nombre, fecha, hora_asig, sin_asignar, historial, rotaciones)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        campanaNormalizada, l.distrito||'', l.n1, l.n2||null,
        l.tipo_contacto||'LLAMADA', l.direccion||'', l.coordenadas||'', l.obs_back||'', tipifBack,
        registraAutor ? req.user.id : null, derivadoPorNombre,
        asesorId, asesorNombre, fechaLead, horaFinal, asesorId?0:1, historial, asesorId?1:0
      ]);
      ids.push(result.insertId);
      if (bloquearRotacion) {
        await db.query(`UPDATE leads SET tipif_vend='NO ROTAR', tipif_hora=? WHERE id=?`, [horaAhora, result.insertId]);
      }
      fechasUsadas.push(fechaLead);
      creados++;
    }

    res.json({
      ok: true,
      creados,
      ids,
      mensaje: `${creados} lead(s) creado(s)`,
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
    if (n1Normalizado !== undefined) {
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

// POST /api/leads/:id/rotar
// Actualiza el lead existente con el nuevo asesor (sin crear duplicados).
// Preserva el historial completo con asesorAnterior, rotadoPor y tipifBackAntes.
router.post('/:id/rotar', auth(ROLES_BO), async (req, res) => {
  let conn;
  try {
    const { asesor_nombre, motivo } = req.body;
    if (!asesor_nombre?.trim()) {
      return res.status(400).json({ ok: false, mensaje: 'Selecciona el nuevo asesor' });
    }

    conn = await db.getConnection();
    await conn.beginTransaction();

    const [leads] = await conn.query(`SELECT * FROM leads WHERE id = ? FOR UPDATE`, [req.params.id]);
    if (!leads.length) {
      await conn.rollback();
      return res.status(404).json({ ok: false, mensaje: 'Lead no encontrado' });
    }
    const lead = leads[0];
    const limiteDiario = resumenSinCoberturaDia(lead, lead.historial);
    if (limiteDiario.aplica && limiteDiario.rotaciones >= 2) {
      await conn.rollback();
      return res.status(409).json({ ok:false, mensaje:'SIN COBERTURA permite un maximo de 2 rotaciones por dia' });
    }
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
    if (tipificacionProhibida(lead.tipif_vend) && !esVentaCaida) {
      await conn.rollback();
      return res.status(409).json({ ok: false, mensaje: `Numero prohibido: ${String(lead.tipif_vend).toUpperCase()}` });
    }
    if (ventasProtegidas.length > 0 && !esVentaCaida) {
      await conn.rollback();
      return res.status(409).json({ ok: false, mensaje: 'Número protegido: ya generó una venta y no se puede rotar' });
    }

    const [usuarios] = await conn.query(`SELECT id, nombre FROM usuarios WHERE nombre = ? AND activo = 1 LIMIT 1`, [asesor_nombre.trim()]);
    if (!usuarios.length) {
      await conn.rollback();
      return res.status(404).json({ ok: false, mensaje: 'Asesor no encontrado o inactivo' });
    }
    const asesorNuevo = usuarios[0];
    if (lead.asesor_id === asesorNuevo.id) {
      await conn.rollback();
      return res.status(409).json({ ok: false, mensaje: 'Selecciona un asesor diferente al actual' });
    }

    const rotadorNombre = await nombreUsuario(req.user.id);

    let historial = [];
    try { historial = JSON.parse(lead.historial || '[]'); } catch { historial = []; }
    const asesorYaUsado = historial.some(h =>
      [h?.asesor, h?.asesorAnterior].some(nombre =>
        String(nombre || '').trim().toUpperCase() === String(asesorNuevo.nombre || '').trim().toUpperCase()
      )
    );
    if (asesorYaUsado) {
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
      tipo:          'ROTACION',
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
      motivo: String(motivo || '').trim() || 'Rotacion manual',
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
    res.json({ ok: true, id: parseInt(req.params.id), asesor: asesorNuevo.nombre, historial, rotaciones:rotacionesReales, mensaje: `Registro rotado a ${asesorNuevo.nombre}` });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error(e);
    res.status(500).json({ ok: false, mensaje: 'Error al rotar el lead' });
  } finally {
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
    const limiteDiario = resumenSinCoberturaDia(lead, lead.historial);
    if (asesorCambia && limiteDiario.aplica && limiteDiario.rotaciones >= 2) {
      return res.status(409).json({ ok:false, mensaje:'SIN COBERTURA permite un maximo de 2 rotaciones por dia' });
    }
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
    const idPrincipalDia = await idLeadMasAntiguoDelDia(db, lead.n1, normalizarFechaAsignacion(lead.fecha));
    if (idPrincipalDia && Number(idPrincipalDia) !== Number(lead.id)) {
      await db.query(`UPDATE leads SET tipif_vend='NO ROTAR', tipif_hora=? WHERE id=?`, [horaPeruAhora(), lead.id]);
      return res.status(409).json({ ok:false, tipif_vend:'NO ROTAR', mensaje:'Solo el primer registro del numero en el dia puede recibir tipificacion' });
    }
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
      if (tipificacionInternaVenta(ventasCRM[0])) {
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
      registrarTipifEvent(historial, lead.asesor_nombre || '', tipifNormalizada, documentoTexto ? { documento:documentoTexto } : {});
      await db.query(`UPDATE leads SET tipif_vend=?, tipif_hora=?, historial=?, obs_asesor=IF(?, ?, obs_asesor), distrito_sin_cobertura=IF(?='SIN COBERTURA',?,distrito_sin_cobertura), coordenadas_sin_cobertura=IF(?='SIN COBERTURA',?,coordenadas_sin_cobertura) WHERE id=?`,
        [tipifNormalizada, horaPeruAhora(), JSON.stringify(historial), documentoTexto !== '' || tipifNormalizada === 'SIN COBERTURA', obsFinal, tipifNormalizada, distrito||'', tipifNormalizada, coordenadas||'', req.params.id]);
      if (esTipificacionOrigen(tipifNormalizada)) await bloquearOtrasCampanasDelDia(db, lead);
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
        registrarTipifEvent(historial, miNombre, tipifNormalizada, documentoTexto ? { documento:documentoTexto } : {});
        await db.query(`UPDATE leads SET tipif_vend=?, tipif_hora=?, historial=?, obs_asesor=IF(?, ?, obs_asesor), distrito_sin_cobertura=IF(?='SIN COBERTURA',?,distrito_sin_cobertura), coordenadas_sin_cobertura=IF(?='SIN COBERTURA',?,coordenadas_sin_cobertura) WHERE id=?`,
          [tipifNormalizada, horaPeruAhora(), JSON.stringify(historial), documentoTexto !== '' || tipifNormalizada === 'SIN COBERTURA', obsFinal, tipifNormalizada, distrito||'', tipifNormalizada, coordenadas||'', req.params.id]);
        if (esTipificacionOrigen(tipifNormalizada)) await bloquearOtrasCampanasDelDia(db, lead);
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
    registrarTipifEvent(historial, miNombre, tipifNormalizada, documentoTexto ? { documento:documentoTexto } : {});
    await db.query(`UPDATE leads SET historial=?, obs_asesor=IF(?, ?, obs_asesor), distrito_sin_cobertura=IF(?='SIN COBERTURA',?,distrito_sin_cobertura), coordenadas_sin_cobertura=IF(?='SIN COBERTURA',?,coordenadas_sin_cobertura) WHERE id=?`,
      [JSON.stringify(historial), documentoTexto !== '' || tipifNormalizada === 'SIN COBERTURA', obsFinal, tipifNormalizada, distrito||'', tipifNormalizada, coordenadas||'', req.params.id]);
    if (esTipificacionOrigen(tipifNormalizada)) await bloquearOtrasCampanasDelDia(db, lead);
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
      h && h.asesor === asesor && (h.hora || '') === (hora || '') && (h.fecha || '') === (fecha || '') &&
      h.tipo !== 'TIPIF_BACK' && h.tipo !== 'DERIVADO' && h.tipo !== 'TIPIF_VEND');
    if (idx < 0) { await conn.rollback(); return res.status(404).json({ ok: false, mensaje: 'Asignación no encontrada' }); }

    const eliminado = historial[idx];
    const nuevoHist = historial.filter((_, i) => i !== idx);
    const eraActual = (lead.asesor_nombre || '') === (eliminado.asesor || '');

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
      const asignaciones = nuevoHist.filter(h => h.asesor && h.tipo !== 'TIPIF_BACK' && h.tipo !== 'DERIVADO' && h.tipo !== 'TIPIF_VEND');
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
router.delete('/fecha/:fecha', auth(ROLES_BO), async (req, res) => {
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

module.exports = router;
