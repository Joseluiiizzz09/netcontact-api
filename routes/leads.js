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
const TIPIF_PROHIBIDAS_ASIGNACION = new Set(['VENTA CERRADA', 'SIN COBERTURA', 'NO TOCAR', 'FRAUDE', 'INSTALADO', 'SH NO ROTAR', 'SH NO TOCAR']);

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
  return v;
}

async function nombreUsuario(id) {
  const [rows] = await db.query(`SELECT nombre FROM usuarios WHERE id = ? LIMIT 1`, [id]);
  return rows[0]?.nombre || 'Usuario Back Data';
}

// GET /api/leads
router.get('/', auth(ROLES_ALL), async (req, res) => {
  try {
    const { fecha, asesor_id, area } = req.query;
    const permisosUsuario = Array.isArray(req.user.permisos) ? req.user.permisos : [];
    if (area && area !== req.user.cargo && !permisosUsuario.includes(area)) {
      return res.status(403).json({ ok: false, mensaje: 'Sin permiso para consultar esta área' });
    }
    const cargoEfectivo = area || req.user.cargo;

    const errGet = validar([errorFecha(fecha, 'fecha')]);
    if (errGet) return res.status(400).json({ ok: false, mensaje: errGet[0] });

    let sql = `SELECT l.*, u.nombre as asesor_nombre_db
      FROM leads l LEFT JOIN usuarios u ON l.asesor_id = u.id WHERE 1=1`;
    const params = [];
    let visorAsesorId = null;
    let visorAsesorNombre = '';

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
      // Si el número ya produjo una venta, queda visible solamente para el
      // asesor que la registró. Los participantes anteriores dejan de verlo
      // aunque permanezcan en el historial para fines de auditoría.
      sql += ` AND (
        NOT EXISTS (SELECT 1 FROM ventas v WHERE TRIM(v.telefono1) = TRIM(l.n1))
        OR EXISTS (SELECT 1 FROM ventas v WHERE TRIM(v.telefono1) = TRIM(l.n1) AND v.asesor_id = ?)
      )`;
      params.push(req.user.id);
    } else if (asesor_id) {
      const [uNom] = await db.query(`SELECT nombre FROM usuarios WHERE id = ? LIMIT 1`, [asesor_id]);
      const nom = uNom[0]?.nombre || '';
      visorAsesorId = Number(asesor_id);
      visorAsesorNombre = nom;
      sql += ` AND (l.asesor_id = ? OR l.historial LIKE CONCAT('%"asesor":"', ?, '"%'))`;
      params.push(asesor_id, nom);
      sql += ` AND (
        NOT EXISTS (SELECT 1 FROM ventas v WHERE TRIM(v.telefono1) = TRIM(l.n1))
        OR EXISTS (SELECT 1 FROM ventas v WHERE TRIM(v.telefono1) = TRIM(l.n1) AND v.asesor_id = ?)
      )`;
      params.push(asesor_id);
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
          `SELECT v.telefono1, v.asesor_id, u.nombre AS asesor_nombre
           FROM ventas v LEFT JOIN usuarios u ON u.id = v.asesor_id
           WHERE TRIM(v.telefono1) IN (${placeholders})
             AND v.id IN (SELECT MAX(id) FROM ventas GROUP BY TRIM(telefono1))`,
          phones
        );
        for (const vv of ventas) {
          ventaMap.set((vv.telefono1 || '').trim(), { venta_asesor_id: vv.asesor_id, venta_asesor_nombre: vv.asesor_nombre });
        }
      }
    }

    const salida = data.map(l => {
      const historial = (() => { try { return JSON.parse(l.historial||'[]'); } catch(e){ return []; } })();
      const rotacionesHistorial = historial.filter(h => String(h?.tipo || '').toUpperCase() === 'ROTACION').length;
      const asignacionesHistorial = historial.filter(h => h?.asesor && String(h?.tipo || '').toUpperCase() !== 'TIPIF_VEND').length;
      const rotacionesReales = Math.max(Number(l.rotaciones || 0), rotacionesHistorial, Math.max(0, asignacionesHistorial - 1));
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
      const ventaCerrada = ventaConfirmada === 1 && ventaAsesorId;
      return {
        ...l,
        rotaciones: rotacionesReales,
        venta_confirmada: ventaConfirmada,
        venta_asesor_id: ventaAsesorId,
        venta_asesor_nombre: ventaAsesorNombre,
        ...(ventaCerrada ? { asesor_id: ventaAsesorId, asesor_nombre: ventaAsesorNombre || l.asesor_nombre, sin_asignar:0, tipif_vend:'VENTA CERRADA' } : {}),
        obs_asesor: obsAsesor,
        historial,
      };
    });
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
        const campana    = String(l.campana    || '').substring(0, 100);
        const distrito   = String(l.distrito   || '').substring(0, 100);
        const tipifBack  = normalizarTipifBack(l.tipif_back);
        const tipifVend  = normalizarTipifVendLegacy(l.tipif_vend).substring(0, 100);
        const hora       = String(l.hora       || '').trim().substring(0, 10);
        const obsAsesor  = String(l.comentario || '').trim().substring(0, 2000) || null;

        // Construir historial desde array de asesores
        const asesores = Array.isArray(l.asesores)
          ? l.asesores.map(a => String(a || '').trim()).filter(a => a.length > 1)
          : [];
        const lastAsesor = asesores.length ? asesores[asesores.length - 1] : '';

        const historialArray = asesores.map((a, i) => ({
          asesor:         a,
          asesorAnterior: i > 0 ? asesores[i - 1] : '',
          tipo:           i > 0 ? 'ROTACION' : '',
          hora:           i === asesores.length - 1 ? hora : '',
          fecha:          fechaLead,
          motivo:         i === 0 ? 'Asignacion importada' : 'Rotacion importada',
          tipif_vend:     i === asesores.length - 1 ? tipifVend : '',
          importado:      true,
        }));

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
      const historial  = asesorId
        ? JSON.stringify([{ asesor: asesorNombre, hora: horaFinal, fecha: fechaHoy, motivo: 'Asignacion inicial' }])
        : '[]';

      const tipifBack = normalizarTipifBack(l.tipif_back);
      const registraAutor = tipifBack === 'DERIVADO' || tipifBack === 'LLAMANDO';
      const derivadoPorNombre = registraAutor ? await nombreUsuario(req.user.id) : '';
      const [result] = await db.query(`
        INSERT INTO leads (campana, distrito, n1, n2, tipo_contacto, direccion, coordenadas, obs_back, tipif_back, derivado_por_id, derivado_por_nombre, asesor_id, asesor_nombre, fecha, hora_asig, sin_asignar, historial)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        l.campana||'', l.distrito||'', l.n1, l.n2||null,
        l.tipo_contacto||'LLAMADA', l.direccion||'', l.coordenadas||'', l.obs_back||'', tipifBack,
        registraAutor ? req.user.id : null, derivadoPorNombre,
        asesorId, asesorNombre, fechaLead, horaFinal, asesorId?0:1, historial
      ]);
      ids.push(result.insertId);
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
    const { tipo_contacto, direccion, coordenadas, obs_back, distrito, n1, n2 } = req.body;
    const errores = validar([
      errorTexto(tipo_contacto, 'tipo_contacto', { max: 20 }),
      errorTexto(direccion, 'direccion', { max: 1000 }),
      errorTexto(coordenadas, 'coordenadas', { max: 255 }),
      errorTexto(obs_back, 'obs_back', { max: 2000 }),
      errorTexto(distrito, 'distrito', { max: 100 }),
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
    if (tipificacionProhibida(lead.tipif_vend)) {
      await conn.rollback();
      return res.status(409).json({ ok: false, mensaje: `Numero prohibido: ${String(lead.tipif_vend).toUpperCase()}` });
    }
    const n1Clean = String(lead.n1 || '').trim();
    const [ventasProtegidas] = await conn.query(
      `SELECT id FROM ventas WHERE TRIM(telefono1) = ? LIMIT 1`,
      [n1Clean]
    );
    if (ventasProtegidas.length > 0) {
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
    if (ultimaAsignacion && !Number.isNaN(ultimaAsignacion.getTime())) {
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
      hora,
      fecha,
      motivo: String(motivo || '').trim() || 'Rotacion manual',
    });

    // Actualiza el registro existente: no crea duplicados.
    await conn.query(`
      UPDATE leads SET
        asesor_id = ?, asesor_nombre = ?,
        tipif_back = '', derivado_por_id = NULL, derivado_por_nombre = '',
        hora_asig = ?, sin_asignar = 0,
        rotaciones = rotaciones + 1,
        tipif_vend = '', tipif_hora = '', obs_asesor = '',
        historial = ?
      WHERE id = ?
    `, [asesorNuevo.id, asesorNuevo.nombre, hora, JSON.stringify(historial), req.params.id]);

    await conn.commit();
    res.json({ ok: true, id: parseInt(req.params.id), asesor: asesorNuevo.nombre, historial, rotaciones:Number(lead.rotaciones || 0) + 1, mensaje: `Registro rotado a ${asesorNuevo.nombre}` });
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
    const { asesor_nombre, tipif_back, hora_asig, historial } = req.body;

    const errores = validar([
      errorHora(hora_asig, 'hora_asig'),
      errorHistorial(historial),
      errorTexto(tipif_back, 'tipif_back', { max: 200 }),
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

    const asesorCambia = !!asesor_nombre && asesor_nombre !== (lead.asesor_nombre || '');
    let reasignadoPorNombre = '';
    if (asesorCambia) {
      reasignadoPorNombre = await nombreUsuario(req.user.id);
    }

    // Historial: inyecta derivadoPor (DERIVADO) y asesorAnterior/reasignadoPor (cambio de asesor).
    let historialJSON;
    if (historial) {
      const histArr = [...historial];
      if (histArr.length > 0) {
        const lastIdx = histArr.length - 1;
        let lastEntry = { ...histArr[lastIdx] };
        if (tipifBackReal === 'DERIVADO' || tipifBackReal === 'LLAMANDO') {
          lastEntry = { ...lastEntry, derivadoPor: derivadoPorNombre };
        }
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
      historialJSON = JSON.stringify(histArr);
    } else {
      historialJSON = lead.historial;
    }

    // Al cambiar de asesor se limpia la tipif_vend del NUEVO asesor (la ve vacía y
    // coloca la suya). La base principal sigue mostrando la del asesor anterior
    // derivándola del historial (tipifVendAntes) hasta que el nuevo tipifique.
    const sqlExtra = asesorCambia ? ', tipif_vend=?, tipif_hora=?, obs_asesor=?' : '';
    const paramsExtra = asesorCambia ? ['', '', ''] : [];

    await db.query(`
      UPDATE leads SET asesor_id=?, asesor_nombre=?, tipif_back=?, hora_asig=?,
        sin_asignar=?, historial=?, rotaciones=rotaciones+?,
        derivado_por_id=?, derivado_por_nombre=?${sqlExtra}
      WHERE id=?
    `, [
      asesorId, asesorNombreReal, asesorCambia ? '' : tipifBackReal,
      horaReal, asesorId?0:1, historialJSON,
      req.body.sumarRotacion?1:0,
      asesorCambia ? null : derivadoPorId, asesorCambia ? '' : derivadoPorNombre,
      ...paramsExtra,
      req.params.id
    ]);

    res.json({ ok: true, mensaje: 'Lead actualizado' });
  } catch(e) {
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
    const tipifNormalizada = String(tipif_vend || '').trim().toUpperCase();
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
    const obsActual = String(lead.obs_asesor || '').trim();
    let obsFinal = documentoTexto && !obsActual.toUpperCase().includes(documentoTexto.toUpperCase())
      ? (obsActual ? `${obsActual} | ${documentoTexto}` : documentoTexto)
      : obsActual;
    if (tipifNormalizada === 'SIN COBERTURA') {
      obsFinal = String(coordenadas || '').trim();
    }
    const esAsesor = req.user.cargo === 'asesor';
    const esActual = Number(lead.asesor_id) === Number(req.user.id);
    if (esAsesor && String(tipif_vend || '').trim().toUpperCase() === 'INSTALADO')
      return res.status(403).json({ ok: false, mensaje: 'La tipificación INSTALADO es exclusiva de Back Data' });
    let historial = [];
    try { historial = JSON.parse(lead.historial || '[]'); } catch { historial = []; }

    // Titular actual, o cargos de gestión (backoffice, etc.): actualiza la tipif vigente
    // del titular + registra el evento (con ts) a nombre del titular actual.
    if (!esAsesor || esActual) {
      registrarTipifEvent(historial, lead.asesor_nombre || '', tipif_vend || '', documentoTexto ? { documento:documentoTexto } : {});
      await db.query(`UPDATE leads SET tipif_vend=?, tipif_hora=?, historial=?, obs_asesor=?, distrito_sin_cobertura=IF(?='SIN COBERTURA',?,distrito_sin_cobertura), coordenadas_sin_cobertura=IF(?='SIN COBERTURA',?,coordenadas_sin_cobertura) WHERE id=?`,
        [tipif_vend||'', horaPeruAhora(), JSON.stringify(historial), obsFinal, tipifNormalizada, distrito||'', tipifNormalizada, coordenadas||'', req.params.id]);
      return res.json({ ok: true, mensaje: 'Tipificación guardada' });
    }

    // Asesor que YA no es el titular: puede ACTUALIZAR su propia tipificación (p.ej.
    // recontactó al cliente). Actualiza su registro en el historial y su evento con ts,
    // para que la base tome la más reciente. No toca la tipif del titular actual.
    const [me] = await db.query(`SELECT nombre FROM usuarios WHERE id = ? LIMIT 1`, [req.user.id]);
    const miNombre = (me[0]?.nombre || '').trim();

    // CASO B: asesor_id nulo/inválido pero soy el asesor actual según la última asignación real del historial.
    // Ocurre cuando el lead fue creado/importado con un nombre que no resolvió a un id en BD.
    if (!lead.asesor_id || Number(lead.asesor_id) === 0) {
      let ultimaAsig = null;
      for (let i = historial.length - 1; i >= 0; i--) {
        const h = historial[i];
        if (h && h.tipo !== 'TIPIF_BACK' && h.tipo !== 'DERIVADO' && h.tipo !== 'TIPIF_VEND') { ultimaAsig = h; break; }
      }
      if (ultimaAsig && (ultimaAsig.asesor || '').trim() === miNombre) {
        registrarTipifEvent(historial, miNombre, tipif_vend || '', documentoTexto ? { documento:documentoTexto } : {});
        await db.query(`UPDATE leads SET tipif_vend=?, tipif_hora=?, historial=?, obs_asesor=?, distrito_sin_cobertura=IF(?='SIN COBERTURA',?,distrito_sin_cobertura), coordenadas_sin_cobertura=IF(?='SIN COBERTURA',?,coordenadas_sin_cobertura) WHERE id=?`,
          [tipif_vend||'', horaPeruAhora(), JSON.stringify(historial), obsFinal, tipifNormalizada, distrito||'', tipifNormalizada, coordenadas||'', req.params.id]);
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
    historial[idx].tipifVendAntes = tipif_vend || '';
    if (documentoTexto) historial[idx].documento = documentoTexto;
    registrarTipifEvent(historial, miNombre, tipif_vend || '', documentoTexto ? { documento:documentoTexto } : {});
    await db.query(`UPDATE leads SET historial=?, obs_asesor=?, distrito_sin_cobertura=IF(?='SIN COBERTURA',?,distrito_sin_cobertura), coordenadas_sin_cobertura=IF(?='SIN COBERTURA',?,coordenadas_sin_cobertura) WHERE id=?`,
      [JSON.stringify(historial), obsFinal, tipifNormalizada, distrito||'', tipifNormalizada, coordenadas||'', req.params.id]);
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
    const [rows] = await db.query(`SELECT id, asesor_id, historial FROM leads WHERE id = ?`, [req.params.id]);
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
    await db.query(`UPDATE leads SET obs_asesor=? WHERE id=?`, [obs||'', req.params.id]);
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
          `UPDATE leads SET asesor_id=?, asesor_nombre=?, sin_asignar=0, tipif_vend=?, tipif_hora='', historial=? WHERE id=?`,
          [asesorId, previo.asesor, tipifPrevio, JSON.stringify(nuevoHist), req.params.id]);
      } else {
        await conn.query(
          `UPDATE leads SET asesor_id=NULL, asesor_nombre='', sin_asignar=1, tipif_vend='', tipif_hora='', historial=? WHERE id=?`,
          [JSON.stringify(nuevoHist), req.params.id]);
      }
    } else {
      await conn.query(`UPDATE leads SET historial=? WHERE id=?`, [JSON.stringify(nuevoHist), req.params.id]);
    }

    // Auditoría para Jefatura/Gerencia: registra quién quitó qué asignación.
    const [actores] = await conn.query(`SELECT nombre, cargo FROM usuarios WHERE id = ? LIMIT 1`, [req.user.id]);
    const actor = actores[0] || {};
    await conn.query(
      `INSERT INTO eliminaciones
        (actor_id, actor_nombre, actor_cargo, tipo, registro_id, detalle, snapshot_json)
       VALUES (?, ?, ?, 'ASIGNACION_BACKDATA', ?, ?, ?)`,
      [req.user.id, actor.nombre || 'Usuario', actor.cargo || req.user.cargo || '', String(req.params.id),
        `Quitó asignación de ${eliminado.asesor || '—'} · N1 ${lead.n1 || '—'} · ${eraActual ? 'era titular actual' : 'asesor anterior'}`,
        JSON.stringify({ entradaEliminada: eliminado, leadN1: lead.n1, leadFecha: lead.fecha })]
    );

    await conn.commit();
    const [after] = await conn.query(`SELECT historial, asesor_nombre, tipif_vend FROM leads WHERE id = ?`, [req.params.id]);
    let histOut = [];
    try { histOut = JSON.parse(after[0].historial || '[]'); } catch { histOut = []; }
    res.json({ ok: true, historial: histOut, asesor: after[0].asesor_nombre || '', tipif_vend: after[0].tipif_vend || '' });
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
