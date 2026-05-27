/* ================================================
   DATABASE.JS — SQLite con better-sqlite3
   ================================================ */
const Database = require('better-sqlite3');
const bcrypt   = require('bcryptjs');

const db = new Database(process.env.DB_PATH || './database.sqlite');

db.pragma('journal_mode = WAL');

// ── CREAR TABLAS ──
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre      TEXT NOT NULL,
    usuario     TEXT UNIQUE NOT NULL,
    password    TEXT NOT NULL,
    cargo       TEXT NOT NULL,
    sala        TEXT,
    genero      TEXT DEFAULT 'M',
    activo      INTEGER DEFAULT 1,
    permisos    TEXT DEFAULT '[]',
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS ventas (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    asesor_id     INTEGER REFERENCES usuarios(id),
    asesor_nombre TEXT,
    tipo_doc      TEXT DEFAULT 'DNI',
    dni           TEXT,
    nombre        TEXT,
    email         TEXT,
    telefono1     TEXT,
    telefono2     TEXT,
    departamento  TEXT,
    provincia     TEXT,
    distrito      TEXT,
    direccion     TEXT,
    coordenadas   TEXT,
    fecha_nac     TEXT,
    lugar_nac     TEXT,
    padre         TEXT,
    madre         TEXT,
    predio        TEXT,
    cuota_inst    TEXT,
    claro_hogar   TEXT,
    tecnologia    TEXT,
    paquete       TEXT,
    full_claro    TEXT,
    cant_decos    INTEGER DEFAULT 0,
    cant_mesh     INTEGER DEFAULT 0,
    plano         TEXT,
    estado        TEXT DEFAULT 'VENTA',
    obs_backoffice TEXT,
    observacion   TEXT,
    created_at    TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS frases (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    texto         TEXT NOT NULL,
    supervisor_id INTEGER REFERENCES usuarios(id),
    sala          TEXT,
    created_at    TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS leads (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    campana       TEXT DEFAULT '—',
    distrito      TEXT DEFAULT '—',
    n1            TEXT NOT NULL,
    n2            TEXT,
    tipif_back    TEXT DEFAULT '',
    asesor_id     INTEGER REFERENCES usuarios(id),
    asesor_nombre TEXT,
    fecha         TEXT NOT NULL,
    hora_asig     TEXT DEFAULT '',
    rotaciones    INTEGER DEFAULT 0,
    sin_asignar   INTEGER DEFAULT 1,
    tipif_vend    TEXT DEFAULT '',
    tipif_hora    TEXT DEFAULT '',
    historial     TEXT DEFAULT '[]',
    created_at    TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// Migraciones seguras — agregan columnas si no existen
const migraciones = [
  `ALTER TABLE usuarios ADD COLUMN permisos TEXT DEFAULT '[]'`,
  `ALTER TABLE ventas   ADD COLUMN asesor_nombre TEXT`,
];
for (const sql of migraciones) {
  try { db.exec(sql); } catch(e) { /* columna ya existe, ignorar */ }
}

// ── USUARIO ADMIN INICIAL ──
const existe = db.prepare(`SELECT id FROM usuarios WHERE usuario = 'admin'`).get();
if (!existe) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare(`
    INSERT INTO usuarios (nombre, usuario, password, cargo, sala, genero, permisos)
    VALUES ('Administrador', 'admin', ?, 'jefatura', 'SALA 1', 'M', '[]')
  `).run(hash);
  console.log('✅ Usuario admin creado (admin / admin123)');
}

module.exports = db;