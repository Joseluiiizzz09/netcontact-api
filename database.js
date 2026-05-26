/* ================================================
   DATABASE.JS — SQLite con better-sqlite3
   ================================================ */
const Database = require('better-sqlite3');
const path     = require('path');
const bcrypt   = require('bcryptjs');

const db = new Database(process.env.DB_PATH || './database.sqlite');

// Habilitar WAL para mejor rendimiento
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
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS ventas (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    asesor_id     INTEGER REFERENCES usuarios(id),
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
`);

// ── USUARIO ADMIN INICIAL ──
const existe = db.prepare(`SELECT id FROM usuarios WHERE usuario = 'admin'`).get();
if (!existe) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare(`
    INSERT INTO usuarios (nombre, usuario, password, cargo, sala, genero)
    VALUES ('Administrador', 'admin', ?, 'jefatura', 'SALA A', 'M')
  `).run(hash);
  console.log('✅ Usuario admin creado (admin / admin123)');
}

module.exports = db;