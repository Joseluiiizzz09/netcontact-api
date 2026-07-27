/* ================================================
   DATABASE.JS â€” MySQL con mysql2
   ================================================ */
require('dotenv').config();
const mysql  = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || 3306,
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'netcontact',
  waitForConnections: true,
  connectionLimit:    50,
  timezone: '-05:00', // Peru UTC-5
  dateStrings: true,  // DATE/DATETIME se entregan sin conversión ISO/UTC
});

/* â”€â”€ CREAR TABLAS â”€â”€ */
async function initDB() {
  const conn = await pool.getConnection();
  try {

    await conn.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        nombre     VARCHAR(150) NOT NULL,
        usuario    VARCHAR(100) UNIQUE NOT NULL,
        password   VARCHAR(255) NOT NULL,
        cargo      VARCHAR(50)  NOT NULL,
        sala       VARCHAR(50),
        genero     VARCHAR(1)   DEFAULT 'M',
        activo     TINYINT(1)   DEFAULT 1,
        permisos   TEXT,
        created_at DATETIME     DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS ventas (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        asesor_id        INT,
        asesor_nombre    VARCHAR(150),
        tipo_doc         VARCHAR(10)  DEFAULT 'DNI',
        dni              VARCHAR(20),
        nombre           VARCHAR(150),
        email            VARCHAR(150),
        telefono1        VARCHAR(20),
        telefono2        VARCHAR(20),
        departamento     VARCHAR(100),
        provincia        VARCHAR(100),
        distrito         VARCHAR(100),
        direccion        TEXT,
        coordenadas      VARCHAR(100),
        fecha_nac        VARCHAR(20),
        lugar_nac        VARCHAR(150),
        padre            VARCHAR(150),
        madre            VARCHAR(150),
        predio           VARCHAR(100),
        cuota_inst       VARCHAR(50),
        claro_hogar      VARCHAR(100),
        tecnologia       VARCHAR(50),
        paquete          VARCHAR(200),
        full_claro       VARCHAR(10),
        cant_decos       INT          DEFAULT 0,
        cant_mesh        INT          DEFAULT 0,
        plano            VARCHAR(100),
        estado           VARCHAR(50)  DEFAULT 'VENTA',
        obs_backoffice   TEXT,
        observacion      TEXT,
        obs_programacion TEXT,
        obs_validacion   TEXT,
        obs_supgrab      TEXT,
        estado_supgrab   VARCHAR(50),
        estado_grab      VARCHAR(50)  DEFAULT 'pendiente',
        audio_path       VARCHAR(255),
        fotos            TEXT,
        created_at       DATETIME     DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (asesor_id) REFERENCES usuarios(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS venta_fotos (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        venta_id   INT NOT NULL,
        nombre     VARCHAR(255) NOT NULL,
        ruta       VARCHAR(255) NOT NULL,
        mimetype   VARCHAR(100) DEFAULT 'image/jpeg',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (venta_id) REFERENCES ventas(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS frases (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        texto         TEXT NOT NULL,
        supervisor_id INT,
        sala          VARCHAR(50),
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (supervisor_id) REFERENCES usuarios(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        campana       VARCHAR(100) DEFAULT '',
        distrito      VARCHAR(100) DEFAULT '',
        n1            VARCHAR(20)  NOT NULL,
        n2            VARCHAR(20),
        tipo_contacto VARCHAR(20)  DEFAULT 'LLAMADA',
        direccion     TEXT,
        coordenadas   VARCHAR(255) DEFAULT '',
        obs_back      TEXT,
        tipif_back    VARCHAR(100) DEFAULT '',
        asesor_id     INT,
        asesor_nombre VARCHAR(150),
        fecha         DATE         NOT NULL,
        hora_asig     VARCHAR(10)  DEFAULT '',
        rotaciones    INT          DEFAULT 0,
        sin_asignar   TINYINT(1)   DEFAULT 1,
        tipif_vend    VARCHAR(100) DEFAULT '',
        tipif_hora    VARCHAR(10)  DEFAULT '',
        obs_asesor    TEXT,
        historial     TEXT,
        created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (asesor_id) REFERENCES usuarios(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS venta_asignaciones (
        id                      INT AUTO_INCREMENT PRIMARY KEY,
        venta_id                INT NOT NULL,
        asesor_anterior_id      INT NULL,
        asesor_anterior_nombre  VARCHAR(150),
        asesor_anterior_sala    VARCHAR(50),
        asesor_nuevo_id         INT NULL,
        asesor_nuevo_nombre     VARCHAR(150) NOT NULL,
        asesor_nuevo_sala       VARCHAR(50),
        cambiado_por_id         INT NULL,
        cambiado_por_nombre     VARCHAR(150) NOT NULL,
        cambiado_por_cargo      VARCHAR(50) NOT NULL,
        created_at              DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (venta_id) REFERENCES ventas(id) ON DELETE CASCADE,
        FOREIGN KEY (asesor_anterior_id) REFERENCES usuarios(id) ON DELETE SET NULL,
        FOREIGN KEY (asesor_nuevo_id) REFERENCES usuarios(id) ON DELETE SET NULL,
        FOREIGN KEY (cambiado_por_id) REFERENCES usuarios(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS venta_historial (
        id                 INT AUTO_INCREMENT PRIMARY KEY,
        venta_id           INT NOT NULL,
        tipo               VARCHAR(50) NOT NULL DEFAULT 'ACTUALIZACION',
        modulo             VARCHAR(80) NOT NULL,
        campo              VARCHAR(80),
        etiqueta           VARCHAR(120),
        valor_anterior     TEXT,
        valor_nuevo        TEXT,
        descripcion        TEXT,
        usuario_id         INT NULL,
        usuario_nombre     VARCHAR(150) NOT NULL,
        usuario_cargo      VARCHAR(50) NOT NULL,
        usuario_sala       VARCHAR(50),
        created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (venta_id) REFERENCES ventas(id) ON DELETE CASCADE,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Compatibilidad con instalaciones existentes: CREATE TABLE no agrega
    // columnas nuevas cuando la tabla ya fue creada.
    const columnasLead = [
      ['tipo_contacto', "VARCHAR(20) DEFAULT 'LLAMADA'"],
      ['direccion',     'TEXT'],
      ['coordenadas',   "VARCHAR(255) DEFAULT ''"],
      ['obs_back',      'TEXT'],
    ];
    for (const [columna, definicion] of columnasLead) {
      await conn.query(`ALTER TABLE leads ADD COLUMN ${columna} ${definicion}`)
        .catch(err => { if (err.code !== 'ER_DUP_FIELDNAME') throw err; });
    }

    // Reclutamiento / RRHH — tabla completamente separada de `leads`
    // (Backoffice comercial). Mismo patrón técnico (asesor_id + historial +
    // rotaciones), sin campos comerciales (tipo_contacto/dirección/
    // coordenadas/obs_back/tipif_back no existen aquí).
    await conn.query(`
      CREATE TABLE IF NOT EXISTS leads_reclutamiento (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        campana          VARCHAR(100) DEFAULT '',
        departamento     VARCHAR(100) DEFAULT '',
        provincia        VARCHAR(100) DEFAULT '',
        distrito         VARCHAR(100) DEFAULT '',
        n1               VARCHAR(20)  NOT NULL,
        n2               VARCHAR(20),
        asesor_id        INT,
        asesor_nombre    VARCHAR(150),
        fecha            DATE         NOT NULL,
        hora_asig        VARCHAR(10)  DEFAULT '',
        rotaciones       INT          DEFAULT 0,
        sin_asignar      TINYINT(1)   DEFAULT 1,
        tipif_vend       VARCHAR(100) DEFAULT '',
        tipif_hora       VARCHAR(10)  DEFAULT '',
        obs_asesor       TEXT,
        historial        TEXT,
        usuario_back_id  INT,
        created_at       DATETIME     DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (asesor_id)       REFERENCES usuarios(id) ON DELETE SET NULL,
        FOREIGN KEY (usuario_back_id) REFERENCES usuarios(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    const [idxLR] = await conn.query(`
      SELECT COUNT(*) AS n FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads_reclutamiento' AND INDEX_NAME = 'idx_lr_asesor_fecha'
    `);
    if (!idxLR[0].n) {
      await conn.query(`CREATE INDEX idx_lr_asesor_fecha ON leads_reclutamiento(asesor_id, fecha)`);
    }
    const [idxLR2] = await conn.query(`
      SELECT COUNT(*) AS n FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads_reclutamiento' AND INDEX_NAME = 'idx_lr_n1'
    `);
    if (!idxLR2[0].n) {
      await conn.query(`CREATE INDEX idx_lr_n1 ON leads_reclutamiento(n1)`);
    }

    // Postulantes de Reclutamiento ("Nuevo Postulante" en dashboardreclutamiento.jsx).
    // Tabla completamente separada de `ventas` (comercial) — solo candidatos a
    // contratación, nunca clientes. sheets_sync_status/synced_at soportan la
    // copia operativa en Google Sheets sin bloquear el guardado en MySQL.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS ventas_reclutamiento (
        id                 INT AUTO_INCREMENT PRIMARY KEY,
        nombre             VARCHAR(150) NOT NULL,
        tipo_doc           VARCHAR(10)  DEFAULT 'DNI',
        dni                VARCHAR(20)  NULL,
        telefono1          VARCHAR(20)  DEFAULT '',
        telefono2          VARCHAR(20)  DEFAULT '',
        distrito           VARCHAR(100) DEFAULT '',
        puesto             VARCHAR(100) DEFAULT '',
        campana            VARCHAR(50)  DEFAULT '',
        empresa            VARCHAR(50)  DEFAULT '',
        experiencia        VARCHAR(100) DEFAULT '',
        disponibilidad     VARCHAR(100) DEFAULT '',
        estado_reclutamiento VARCHAR(50) DEFAULT 'NUEVO',
        fecha_entrevista   DATE         NULL,
        hora_entrevista    VARCHAR(10)  DEFAULT '',
        observacion        TEXT,
        usuario_id         INT,
        sheets_sync_status VARCHAR(20)  DEFAULT 'PENDING',
        sheets_synced_at   DATETIME     NULL,
        created_at         DATETIME     DEFAULT CURRENT_TIMESTAMP,
        updated_at         DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    const [idxVR] = await conn.query(`
      SELECT COUNT(*) AS n FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ventas_reclutamiento' AND INDEX_NAME = 'idx_vr_usuario_fecha'
    `);
    if (!idxVR[0].n) {
      await conn.query(`CREATE INDEX idx_vr_usuario_fecha ON ventas_reclutamiento(usuario_id, created_at)`);
    }
    // DNI ahora es opcional al registrar un postulante (compatibilidad con
    // instalaciones existentes donde la tabla ya se creó con dni NOT NULL).
    await conn.query(`ALTER TABLE ventas_reclutamiento MODIFY dni VARCHAR(20) NULL`).catch(() => {});
    const [idxVR2] = await conn.query(`
      SELECT COUNT(*) AS n FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ventas_reclutamiento' AND INDEX_NAME = 'idx_vr_dni'
    `);
    if (!idxVR2[0].n) {
      await conn.query(`CREATE INDEX idx_vr_dni ON ventas_reclutamiento(dni)`);
    }

    // Responsable de "GRABANDO" en Grabaciones — columna independiente del
    // estado_grab (que se mantiene únicamente en {"grabando"}), nullable
    // para no romper ventas históricas. Se setea siempre server-side desde
    // el token, nunca desde el frontend (ver PATCH /:id en routes/ventas.js).
    await conn.query(`ALTER TABLE ventas ADD COLUMN grabando_por_id INT NULL`)
      .catch(err => { if (err.code !== 'ER_DUP_FIELDNAME') throw err; });
    // Verificación vía information_schema (portable entre MySQL y MariaDB,
    // a diferencia de capturar códigos de error de ALTER que difieren entre
    // motores) para no reintentar el ALTER si el FK ya existe.
    const [fkExistente] = await conn.query(`
      SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ventas'
        AND CONSTRAINT_NAME = 'fk_ventas_grabando_por' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
    `);
    if (!fkExistente[0].n) {
      await conn.query(`
        ALTER TABLE ventas ADD CONSTRAINT fk_ventas_grabando_por
          FOREIGN KEY (grabando_por_id) REFERENCES usuarios(id) ON DELETE SET NULL
      `);
    }

    // Seguimiento: tramo/comentario/motivo propios de esa etapa (nullable,
    // no rompen ventas históricas). Independientes de `observacion` (nota
    // original del asesor) y de obs_backoffice/obs_programacion/
    // obs_validacion/obs_supgrab (una columna dedicada por etapa, mismo
    // patrón aquí).
    const columnasSeguimiento = [
      ['obs_seguimiento',    'TEXT NULL'],
      ['tramo_seguimiento',  'VARCHAR(20) NULL'],
      ['motivo_seguimiento', 'VARCHAR(150) NULL'],
    ];
    for (const [columna, definicion] of columnasSeguimiento) {
      await conn.query(`ALTER TABLE ventas ADD COLUMN ${columna} ${definicion}`)
        .catch(err => { if (err.code !== 'ER_DUP_FIELDNAME') throw err; });
    }

    // -- INDICES PARA RENDIMIENTO (150+ usuarios) --
    const indices = [
      'CREATE INDEX IF NOT EXISTS idx_ventas_created ON ventas(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_ventas_asesor ON ventas(asesor_id)',
      'CREATE INDEX IF NOT EXISTS idx_ventas_estado ON ventas(estado)',
      'CREATE INDEX IF NOT EXISTS idx_ventas_dni ON ventas(dni)',
      'CREATE INDEX IF NOT EXISTS idx_ventas_grab ON ventas(estado_grab)',
      'CREATE INDEX IF NOT EXISTS idx_ventas_supgrab ON ventas(estado_supgrab)',
      'CREATE INDEX IF NOT EXISTS idx_leads_fecha ON leads(fecha)',
      'CREATE INDEX IF NOT EXISTS idx_leads_asesor ON leads(asesor_id)',
      'CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_leads_n1 ON leads(n1)',
      'CREATE INDEX IF NOT EXISTS idx_frases_created ON frases(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_fotos_venta ON venta_fotos(venta_id)',
      'CREATE INDEX IF NOT EXISTS idx_venta_asignaciones_venta ON venta_asignaciones(venta_id, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_venta_historial_venta ON venta_historial(venta_id, created_at)',
    ];
    for (const idx of indices) { await conn.query(idx).catch(() => {}); }
    console.log('Indices de rendimiento verificados');

    // -- USUARIO ADMIN INICIAL --
    const [rows] = await conn.query(`SELECT id FROM usuarios WHERE usuario = 'admin'`);
    if (!rows.length) {
      const adminPass = process.env.ADMIN_PASSWORD;
      if (!adminPass) {
        console.warn('[WARN] ADMIN_PASSWORD no está definida en .env. Usuario admin no fue creado.');
      } else {
        const hash = bcrypt.hashSync(adminPass, 10);
        await conn.query(`
          INSERT INTO usuarios (nombre, usuario, password, cargo, sala, genero, permisos)
          VALUES ('Administrador', 'admin', ?, 'jefatura', 'SALA 1', 'M', '[]')
        `, [hash]);
        console.log('✅ Usuario admin creado con la contraseña de ADMIN_PASSWORD');
      }
    }

    console.log('âœ… Base de datos MySQL iniciada correctamente');
  } finally {
    conn.release();
  }
}

initDB().catch(err => {
  console.error('âŒ Error iniciando base de datos:', err.message);
  process.exit(1);
});

module.exports = pool;

