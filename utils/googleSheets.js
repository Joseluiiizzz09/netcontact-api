/* ================================================
   UTILS/GOOGLESHEETS.JS
   Copia operativa en Google Sheets de los postulantes de Reclutamiento
   (tabla ventas_reclutamiento). MySQL sigue siendo la fuente principal —
   esto solo espeja datos ya guardados, nunca al revés. Si Sheets falla o no
   está configurado, el guardado en MySQL nunca se ve afectado (ver
   syncPostulanteToSheet, siempre resuelve, nunca lanza).
   ================================================ */
const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const SERVICE_EMAIL  = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const PRIVATE_KEY    = process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '';

const HOJA_POSTULANTES = 'POSTULANTES';
const HOJA_RESUMEN     = 'RESUMEN';

const HEADER_POSTULANTES = [
  'ID','FECHA REGISTRO','HORA REGISTRO','NOMBRES Y APELLIDOS','TIPO DOCUMENTO','DOCUMENTO / DNI',
  'TELÉFONO PRINCIPAL','TELÉFONO SECUNDARIO','DISTRITO','ZONA / CLASIFICACIÓN DISTRITO',
  'PUESTO AL QUE POSTULA','CAMPAÑA RECLUTAMIENTO','EMPRESA','EXPERIENCIA CALL CENTER',
  'DISPONIBILIDAD / HORARIO','CLASIFICACIÓN HORARIA','ESTADO RECLUTAMIENTO','OBSERVACIÓN',
  'USUARIO / RECLUTADOR','FECHA ÚLTIMA ACTUALIZACIÓN',
];

// Agrupación geográfica de los 42 distritos de Lima Metropolitana que usa el
// formulario (src/pages/dashboardreclutamiento.jsx). Distritos no listados
// explícitamente por el usuario se ubicaron por cercanía geográfica real
// (Cercado de Lima/La Victoria/San Luis -> Centro, Chaclacayo -> Este).
// Si en el futuro se habilitan distritos de Callao, agregar aquí como 'CALLAO'.
const ZONAS_DISTRITO = {
  'Los Olivos':'LIMA NORTE','San Martín de Porres':'LIMA NORTE','Independencia':'LIMA NORTE',
  'Comas':'LIMA NORTE','Carabayllo':'LIMA NORTE','Puente Piedra':'LIMA NORTE','Ancón':'LIMA NORTE',
  'Santa Rosa':'LIMA NORTE',
  'Lima':'LIMA CENTRO','Cercado de Lima':'LIMA CENTRO','Breña':'LIMA CENTRO','Jesús María':'LIMA CENTRO',
  'Lince':'LIMA CENTRO','Pueblo Libre':'LIMA CENTRO','Magdalena del Mar':'LIMA CENTRO',
  'San Miguel':'LIMA CENTRO','Rímac':'LIMA CENTRO','La Victoria':'LIMA CENTRO','San Luis':'LIMA CENTRO',
  'Ate':'LIMA ESTE','Santa Anita':'LIMA ESTE','El Agustino':'LIMA ESTE',
  'San Juan de Lurigancho':'LIMA ESTE','Lurigancho':'LIMA ESTE','La Molina':'LIMA ESTE',
  'Cieneguilla':'LIMA ESTE','Chaclacayo':'LIMA ESTE',
  'San Juan de Miraflores':'LIMA SUR','Villa María del Triunfo':'LIMA SUR','Villa El Salvador':'LIMA SUR',
  'Chorrillos':'LIMA SUR','Lurín':'LIMA SUR','Pachacámac':'LIMA SUR','Punta Hermosa':'LIMA SUR',
  'San Bartolo':'LIMA SUR','Santa María del Mar':'LIMA SUR','Pucusana':'LIMA SUR',
  'Miraflores':'LIMA MODERNA','San Isidro':'LIMA MODERNA','Santiago de Surco':'LIMA MODERNA',
  'Surquillo':'LIMA MODERNA','Barranco':'LIMA MODERNA','San Borja':'LIMA MODERNA',
}

// La disponibilidad real del sistema (DISPONIBILIDAD_RECLU en
// dashboardreclutamiento.jsx) no distingue turnos (mañana/tarde/noche), así
// que la clasificación horaria refleja esas mismas opciones tal como existen
// — no se inventan turnos que el sistema no captura.
const CLASIFICACION_HORARIA = {
  'inmediata':'INMEDIATA', 'esta semana':'ESTA SEMANA',
  'próxima semana':'PRÓXIMA SEMANA', 'proxima semana':'PRÓXIMA SEMANA',
  'otra fecha':'OTRA FECHA',
}

function zonaDeDistrito(distrito) {
  return ZONAS_DISTRITO[String(distrito || '').trim()] || 'SIN CLASIFICAR'
}

function clasificacionHoraria(disponibilidad) {
  const key = String(disponibilidad || '').trim().toLowerCase()
  return CLASIFICACION_HORARIA[key] || 'OTRO'
}

function formatFechaPeru(fecha) {
  if (!fecha) return ''
  const d = new Date(fecha)
  if (isNaN(d)) return ''
  return new Intl.DateTimeFormat('en-CA', { timeZone:'America/Lima', year:'numeric', month:'2-digit', day:'2-digit' }).format(d)
}
function formatHoraPeru(fecha) {
  if (!fecha) return ''
  const d = new Date(fecha)
  if (isNaN(d)) return ''
  return new Intl.DateTimeFormat('es-PE', { timeZone:'America/Lima', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(d)
}

let _sheetsClient = null
function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient
  const auth = new google.auth.JWT({ email: SERVICE_EMAIL, key: PRIVATE_KEY, scopes: ['https://www.googleapis.com/auth/spreadsheets'] })
  _sheetsClient = google.sheets({ version:'v4', auth })
  return _sheetsClient
}

function sheetsConfigurado() {
  return !!(SPREADSHEET_ID && SERVICE_EMAIL && PRIVATE_KEY)
}

let _avisoNoConfigurado = false
let _bootstrapHecho = false

function letraColumna(indice) {
  let n = indice + 1
  let letra = ''
  while (n > 0) {
    n--
    letra = String.fromCharCode(65 + (n % 26)) + letra
    n = Math.floor(n / 26)
  }
  return letra
}

function columnasResumen(cabecera) {
  const buscar = nombre => {
    const indice = cabecera.indexOf(nombre)
    if (indice < 0) throw new Error(`Encabezado requerido no encontrado en ${HOJA_POSTULANTES}: ${nombre}`)
    return letraColumna(indice)
  }
  return {
    id:             buscar('ID'),
    fecha:          buscar('FECHA REGISTRO'),
    distrito:       buscar('DISTRITO'),
    zona:           buscar('ZONA / CLASIFICACIÓN DISTRITO'),
    puesto:         buscar('PUESTO AL QUE POSTULA'),
    campana:        buscar('CAMPAÑA RECLUTAMIENTO'),
    empresa:        buscar('EMPRESA'),
    disponibilidad: buscar('DISPONIBILIDAD / HORARIO'),
    estado:         buscar('ESTADO RECLUTAMIENTO'),
    reclutador:     buscar('USUARIO / RECLUTADOR'),
  }
}

function formulaAgrupada(columna) {
  return `=IFERROR(QUERY(${HOJA_POSTULANTES}!${columna}2:${columna},"select ${columna}, count(${columna}) where ${columna} is not null group by ${columna} order by count(${columna}) desc label count(${columna}) ''"),"")`
}

// Las letras se resuelven desde la cabecera real para que RESUMEN no dependa
// de posiciones históricas si las columnas de POSTULANTES cambian de orden.
function filasResumen(columnas) {
  const filas = [
    ['RESUMEN RECLUTAMIENTO', '', ''],
    ['', '', ''],
    ['TOTAL POSTULANTES', `=COUNTA(${HOJA_POSTULANTES}!${columnas.id}2:${columnas.id})`, ''],
    ['', '', ''],
    ['POR EMPRESA', '', ''],
    ['CLARO', `=COUNTIF(${HOJA_POSTULANTES}!${columnas.empresa}2:${columnas.empresa},"CLARO")`, ''],
    ['WIN',   `=COUNTIF(${HOJA_POSTULANTES}!${columnas.empresa}2:${columnas.empresa},"WIN")`, ''],
    ['', '', ''],
    ['POR CAMPAÑA', '', ''],
    ['R3',      `=COUNTIF(${HOJA_POSTULANTES}!${columnas.campana}2:${columnas.campana},"R3")`, ''],
    ['R4',      `=COUNTIF(${HOJA_POSTULANTES}!${columnas.campana}2:${columnas.campana},"R4")`, ''],
    ['R5',      `=COUNTIF(${HOJA_POSTULANTES}!${columnas.campana}2:${columnas.campana},"R5")`, ''],
    ['CHANCAY', `=COUNTIF(${HOJA_POSTULANTES}!${columnas.campana}2:${columnas.campana},"CHANCAY")`, ''],
    ['', '', ''],
    ['POR ZONA', '', ''],
    ['LIMA NORTE',   `=COUNTIF(${HOJA_POSTULANTES}!${columnas.zona}2:${columnas.zona},"LIMA NORTE")`, ''],
    ['LIMA CENTRO',  `=COUNTIF(${HOJA_POSTULANTES}!${columnas.zona}2:${columnas.zona},"LIMA CENTRO")`, ''],
    ['LIMA ESTE',    `=COUNTIF(${HOJA_POSTULANTES}!${columnas.zona}2:${columnas.zona},"LIMA ESTE")`, ''],
    ['LIMA SUR',     `=COUNTIF(${HOJA_POSTULANTES}!${columnas.zona}2:${columnas.zona},"LIMA SUR")`, ''],
    ['LIMA MODERNA', `=COUNTIF(${HOJA_POSTULANTES}!${columnas.zona}2:${columnas.zona},"LIMA MODERNA")`, ''],
    ['', '', ''],
    ['POR ESTADO', '', ''],
    ['NUEVO', `=COUNTIF(${HOJA_POSTULANTES}!${columnas.estado}2:${columnas.estado},"NUEVO")`, ''],
    ['', '', ''],
    ['POR DISTRITO (detalle)', 'CANTIDAD', ''],
    [formulaAgrupada(columnas.distrito), '', ''],
  ]
  // 24 filas fijas arriba; a partir de aquí se insertan bloques QUERY que
  // ocupan varias filas dinámicamente (Sheets las expande solo). Se dejan en
  // columnas separadas para no chocar con las filas fijas de arriba.
  return filas
}

async function ensureSheetsBootstrap() {
  if (_bootstrapHecho || !sheetsConfigurado()) return
  const sheets = getSheetsClient()
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID })
  const titulos = (meta.data.sheets || []).map(s => s.properties.title)
  const faltantes = [HOJA_POSTULANTES, HOJA_RESUMEN].filter(t => !titulos.includes(t))

  if (faltantes.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: faltantes.map(title => ({ addSheet: { properties: { title } } })) },
    })
  }

  const cabecera = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${HOJA_POSTULANTES}!1:1` })
  if (!cabecera.data.values || !cabecera.data.values.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${HOJA_POSTULANTES}!A1`,
      valueInputOption: 'USER_ENTERED', requestBody: { values: [HEADER_POSTULANTES] },
    })
  }

  const cabeceraReal = (cabecera.data.values && cabecera.data.values[0]) || HEADER_POSTULANTES
  const columnas = columnasResumen(cabeceraReal)
  // Reconciliar siempre RESUMEN: una hoja existente puede conservar fórmulas
  // antiguas aunque POSTULANTES ya tenga la estructura correcta.
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `${HOJA_RESUMEN}!A1`,
    valueInputOption: 'USER_ENTERED', requestBody: { values: filasResumen(columnas) },
  })
  // Desgloses abiertos (distrito/día/reclutador/disponibilidad/puesto) —
  // se ubican en columnas separadas para no interferir con el bloque fijo A-B.
  const bloques = [
    ['E1', 'POR DISTRITO',       columnas.distrito],
    ['H1', 'POR PUESTO',         columnas.puesto],
    ['K1', 'POR DISPONIBILIDAD', columnas.disponibilidad],
    ['N1', 'POR RECLUTADOR',     columnas.reclutador],
    ['Q1', 'POR FECHA',          columnas.fecha],
  ]
  for (const [celda, titulo, columna] of bloques) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${HOJA_RESUMEN}!${celda}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[titulo, ''], [formulaAgrupada(columna), '']] },
    })
  }

  _bootstrapHecho = true
}

function mapPostulanteToRow(p) {
  const distrito = p.distrito || ''
  return [
    p.id,
    formatFechaPeru(p.created_at),
    formatHoraPeru(p.created_at),
    p.nombre || '',
    p.tipo_doc || 'DNI',
    p.dni || '',
    p.telefono1 || '',
    p.telefono2 || '',
    distrito,
    zonaDeDistrito(distrito),
    p.puesto || '',
    p.campana || '',
    p.empresa || '',
    p.experiencia || '',
    p.disponibilidad || '',
    clasificacionHoraria(p.disponibilidad),
    p.estado_reclutamiento || 'NUEVO',
    p.observacion || '',
    p.usuario_nombre || '',
    `${formatFechaPeru(p.updated_at || p.created_at)} ${formatHoraPeru(p.updated_at || p.created_at)}`.trim(),
  ]
}

// Upsert por ID (columna A). Nunca lanza — el llamador decide qué hacer con
// el resultado (marcar sheets_sync_status), pero el guardado en MySQL ya
// ocurrió antes de invocar esto y no depende de su resultado.
async function syncPostulanteToSheet(postulante) {
  if (!sheetsConfigurado()) {
    if (!_avisoNoConfigurado) {
      console.warn('[GOOGLE SHEETS] No configurado (GOOGLE_SHEETS_SPREADSHEET_ID/GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_PRIVATE_KEY) — sync omitido.')
      _avisoNoConfigurado = true
    }
    return { ok:false, motivo:'not_configured' }
  }
  try {
    await ensureSheetsBootstrap()
    const sheets = getSheetsClient()
    const columnaId = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${HOJA_POSTULANTES}!A2:A` })
    const ids = (columnaId.data.values || []).map(r => String(r[0] || ''))
    const idx = ids.indexOf(String(postulante.id))
    const fila = mapPostulanteToRow(postulante)

    // RAW (no USER_ENTERED): los campos vienen de texto libre del postulante
    // (nombre, observación...) — con USER_ENTERED, un valor que empiece con
    // =/+/-/@ se interpretaría como fórmula en Sheets. RAW lo guarda literal.
    if (idx >= 0) {
      const numFila = idx + 2
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID, range: `${HOJA_POSTULANTES}!A${numFila}:T${numFila}`,
        valueInputOption: 'RAW', requestBody: { values: [fila] },
      })
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: `${HOJA_POSTULANTES}!A:T`,
        valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [fila] },
      })
    }
    return { ok:true }
  } catch(e) {
    // Sin datos sensibles en el log — solo el motivo del fallo.
    console.error('[GOOGLE SHEETS] Error sincronizando postulante id=' + postulante.id + ':', e.message)
    return { ok:false, motivo:e.message }
  }
}

module.exports = { syncPostulanteToSheet, sheetsConfigurado }
