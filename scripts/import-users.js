'use strict';
/**
 * Importador seguro de usuarios — NETCONTACT
 *
 * Uso:
 *   node scripts/import-users.js --file <ruta.json> --dry-run
 *   node scripts/import-users.js --file <ruta.json> --execute
 *
 * Nunca imprime contraseñas en claro. No modifica server.js ni se carga
 * automáticamente. Usa transacción con rollback ante cualquier fallo.
 */

require('dotenv').config();
const fs     = require('fs');
const path   = require('path');
const bcrypt = require('bcryptjs');
const mysql  = require('mysql2/promise');

/* ── Argumentos ─────────────────────────────────────────────────────── */
const args    = process.argv.slice(2);
const fileArg = args.indexOf('--file');
const isDry   = args.includes('--dry-run');
const isExec  = args.includes('--execute');

if (fileArg === -1 || !args[fileArg + 1]) {
  console.error('Error: debes indicar --file <ruta.json>');
  process.exit(1);
}
if (!isDry && !isExec) {
  console.error('Error: debes indicar --dry-run o --execute');
  process.exit(1);
}

const filePath = path.resolve(args[fileArg + 1]);

/* ── Constantes de validación ───────────────────────────────────────── */
const CARGOS_VALIDOS = new Set([
  'backoffice', 'jefatura', 'grabaciones', 'supgrabaciones',
  'backreclutamiento', 'asesorreclutamiento', 'seguimiento',
  'validacion', 'programacion', 'usuarios', 'supervisor', 'asesor',
]);
const SALAS_VALIDAS = new Set(['SALA 1', 'SALA 2', 'SALA 3', 'SALA 4', 'SALA CHANCAY']);
const TOTAL_ESPERADO = 127;

/* ── Helpers ────────────────────────────────────────────────────────── */
function bloquear(msg) { console.error(`\n[BLOQUEADO] ${msg}`); process.exit(1); }

function validarUsuario(u, idx, loginsEnArchivo) {
  const errores = [];
  if (!u.nombre  || !u.nombre.trim())    errores.push('nombre obligatorio');
  if (!u.usuario || !u.usuario.trim())   errores.push('login obligatorio');
  if (!u.cargo   || !u.cargo.trim())     errores.push('cargo obligatorio');
  if (!u.password || u.password.length < 6) errores.push('contraseña obligatoria (mínimo 6 chars)');
  if (u.cargo && !CARGOS_VALIDOS.has(u.cargo)) errores.push(`cargo inválido: ${u.cargo}`);
  if (u.sala !== null && u.sala !== undefined && !SALAS_VALIDAS.has(u.sala))
    errores.push(`sala inválida: ${u.sala}`);
  if (Array.isArray(u.permisos)) {
    for (const p of u.permisos) {
      if (!CARGOS_VALIDOS.has(p)) errores.push(`permiso inválido: ${p}`);
      if (p === u.cargo)          errores.push(`permiso igual al cargo principal: ${p}`);
    }
  }
  if (u.usuario && loginsEnArchivo.filter(l => l === u.usuario.toLowerCase()).length > 1)
    errores.push('login duplicado dentro del archivo');
  return errores;
}

/* ── Main ───────────────────────────────────────────────────────────── */
async function main() {
  /* 1. Leer archivo */
  if (!fs.existsSync(filePath)) bloquear(`Archivo no encontrado: ${filePath}`);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (e) { bloquear(`JSON inválido: ${e.message}`); }

  const users = raw.users;
  if (!Array.isArray(users)) bloquear('El archivo no contiene un arreglo "users".');

  /* 2. Verificar cantidad */
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(` NETCONTACT — Importador de usuarios`);
  console.log(` Modo: ${isDry ? 'DRY-RUN (sin cambios)' : 'EJECUCIÓN REAL'}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  console.log(`Archivo : ${filePath}`);
  console.log(`Leídos  : ${users.length}`);

  if (users.length !== TOTAL_ESPERADO)
    bloquear(`Se esperaban ${TOTAL_ESPERADO} usuarios, el archivo contiene ${users.length}.`);

  /* 3. Validar estructura de cada usuario */
  const loginsEnArchivo = users.map(u => (u.usuario || '').toLowerCase());
  const erroresEstructura = [];
  for (let i = 0; i < users.length; i++) {
    const errs = validarUsuario(users[i], i, loginsEnArchivo);
    if (errs.length) {
      erroresEstructura.push({ fila: users[i].source_row || i + 2, login: users[i].usuario, errs });
    }
  }
  if (erroresEstructura.length) {
    console.error('\n[ERROR] Errores estructurales encontrados:');
    erroresEstructura.forEach(e => {
      console.error(`  Fila ${e.fila} (${e.login}): ${e.errs.join('; ')}`);
    });
    bloquear('Corrija los errores antes de importar.');
  }
  console.log(`Validación estructural: OK (${users.length} usuarios válidos)\n`);

  /* 4. Conectar a la BD */
  const pool = mysql.createPool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     process.env.DB_PORT     || 3306,
    user:     process.env.DB_USER     || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME     || 'netcontact',
    waitForConnections: true,
    connectionLimit: 5,
    timezone: '-05:00',
  });

  const conn = await pool.getConnection();
  try {
    /* 5. Obtener logins existentes (insensible a mayúsculas) */
    const [existentes] = await conn.query(`SELECT LOWER(usuario) AS u FROM usuarios`);
    const loginsBD = new Set(existentes.map(r => r.u));

    /* 6. Clasificar usuarios */
    const nuevos    = [];
    const omitidos  = [];

    for (const u of users) {
      const loginNorm = u.usuario.toLowerCase();
      if (loginsBD.has(loginNorm)) {
        omitidos.push(u.usuario);
      } else {
        nuevos.push(u);
      }
    }

    /* 7. Resumen previo */
    const cargoCounts  = {};
    const salaCounts   = {};
    const permisoCounts = {};

    for (const u of nuevos) {
      cargoCounts[u.cargo]  = (cargoCounts[u.cargo]  || 0) + 1;
      const salaKey = u.sala || 'SIN SALA';
      salaCounts[salaKey]   = (salaCounts[salaKey]   || 0) + 1;
      for (const p of (u.permisos || [])) {
        permisoCounts[p]    = (permisoCounts[p]    || 0) + 1;
      }
    }

    console.log(`── RESUMEN ──────────────────────────────────────────`);
    console.log(`  Total leídos    : ${users.length}`);
    console.log(`  Usuarios nuevos : ${nuevos.length}`);
    console.log(`  Ya existentes   : ${omitidos.length}`);
    console.log(`  Errores         : 0`);
    console.log(`  Total (new+exist): ${nuevos.length + omitidos.length}`);
    if (nuevos.length + omitidos.length !== TOTAL_ESPERADO)
      bloquear(`nuevos + existentes ≠ ${TOTAL_ESPERADO}`);

    console.log(`\n── POR CARGO (nuevos a crear) ───────────────────────`);
    Object.entries(cargoCounts).sort().forEach(([k,v]) => console.log(`  ${k.padEnd(20)}: ${v}`));

    console.log(`\n── POR SALA (nuevos a crear) ────────────────────────`);
    Object.entries(salaCounts).sort().forEach(([k,v]) => console.log(`  ${k.padEnd(20)}: ${v}`));

    console.log(`\n── PERMISOS ADICIONALES (nuevos) ───────────────────`);
    if (Object.keys(permisoCounts).length === 0) {
      console.log('  (ninguno)');
    } else {
      Object.entries(permisoCounts).sort().forEach(([k,v]) => console.log(`  ${k.padEnd(20)}: ${v}`));
    }

    if (omitidos.length > 0) {
      console.log(`\n── LOGINS OMITIDOS (ya existen en BD) ──────────────`);
      omitidos.forEach(l => console.log(`  ${l}`));
    }

    /* 8. Si es dry-run, terminar aquí */
    if (isDry) {
      console.log(`\n[DRY-RUN] No se realizó ningún cambio en la base de datos.`);
      console.log(`[DRY-RUN] Para importar: --execute\n`);
      return;
    }

    /* 9. EJECUCIÓN REAL: transacción */
    console.log(`\n── IMPORTACIÓN REAL ────────────────────────────────`);
    await conn.beginTransaction();

    const creados = [];
    const fallidos = [];

    try {
      for (const u of nuevos) {
        const hash = await bcrypt.hash(u.password, 10);
        const permisos = JSON.stringify(Array.isArray(u.permisos) ? u.permisos : []);
        const sala     = u.sala || null;

        const [result] = await conn.query(
          `INSERT INTO usuarios (nombre, usuario, password, cargo, sala, activo, permisos)
           VALUES (?, ?, ?, ?, ?, 1, ?)`,
          [u.nombre.trim(), u.usuario.toLowerCase(), hash, u.cargo, sala, permisos]
        );
        creados.push({ id: result.insertId, login: u.usuario.toLowerCase() });
      }

      await conn.commit();
      console.log(`  Transacción confirmada. ${creados.length} usuarios insertados.`);

    } catch (e) {
      await conn.rollback();
      console.error(`\n[ERROR] Fallo durante la inserción. Rollback ejecutado.`);
      console.error(`  Detalle: ${e.message}`);
      throw e;
    }

    /* 10. Reporte de auditoría */
    const reporte = {
      fecha: new Date().toISOString(),
      modo: 'execute',
      archivo: path.basename(filePath),
      total_procesado: users.length,
      total_creado: creados.length,
      total_existente: omitidos.length,
      total_fallido: fallidos.length,
      ids_creados: creados.map(c => c.id),
      logins_creados: creados.map(c => c.login),
      logins_omitidos: omitidos,
      errores: [],
      por_cargo: cargoCounts,
      por_sala: salaCounts,
      permisos_adicionales: permisoCounts,
    };

    const reportePath = path.join(path.dirname(filePath), 'resultados-importacion-usuarios.json');
    fs.writeFileSync(reportePath, JSON.stringify(reporte, null, 2), 'utf8');
    console.log(`\n  Auditoría guardada en: ${reportePath}`);

    /* 11. Resumen final */
    console.log(`\n── RESULTADO FINAL ─────────────────────────────────`);
    console.log(`  Creados  : ${creados.length}`);
    console.log(`  Omitidos : ${omitidos.length}`);
    console.log(`  Fallidos : ${fallidos.length}`);
    console.log(`  Total    : ${creados.length + omitidos.length} / ${TOTAL_ESPERADO}`);
    console.log(`  Contraseñas: hasheadas con bcrypt (salt 10) — ninguna en claro`);
    console.log(`\n[OK] Importación completada.\n`);

  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch(e => {
  console.error(`[ERROR FATAL] ${e.message}`);
  process.exit(1);
});
