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
    ];
    for (const idx of indices) { await conn.query(idx).catch(() => {}); }
    console.log('Indices de rendimiento verificados');

    // -- USUARIO ADMIN INICIAL --
    const [rows] = await conn.query(`SELECT id FROM usuarios WHERE usuario = 'admin'`);
    if (!rows.length) {
      const hash = bcrypt.hashSync('admin123', 10);
      await conn.query(`
        INSERT INTO usuarios (nombre, usuario, password, cargo, sala, genero, permisos)
        VALUES ('Administrador', 'admin', ?, 'jefatura', 'SALA 1', 'M', '[]')
      `, [hash]);
      console.log('âœ… Usuario admin creado (admin / admin123)');
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

