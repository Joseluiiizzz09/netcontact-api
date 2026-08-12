require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const rateLimit  = require('express-rate-limit');
const helmet     = require('helmet');
const auth       = require('./middleware/auth');

const app = express();
app.use(express.json({ limit: '5mb' }));

const FRONTEND_URL = process.env.FRONTEND_URL;
if (!FRONTEND_URL || FRONTEND_URL === '*') {
  console.warn('[WARN] FRONTEND_URL no está definida o es "*". Configúrala en .env para producción.');
}
app.use(cors({
  origin: (!FRONTEND_URL || FRONTEND_URL === '*') ? '*' : FRONTEND_URL.split(',').map(u => u.trim()),
  methods: ['GET','POST','PATCH','PUT','DELETE'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: false,
}));

app.use('/api/login', rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  // La empresa comparte una misma IP publica. El bloqueo debe pertenecer a la
  // cuenta que acumula fallos, no a toda la oficina.
  keyGenerator: req => `usuario:${String(req.body?.usuario || '').trim().toLowerCase()}`,
  skipSuccessfulRequests: true,
  message: { ok: false, mensaje: 'Usuario bloqueado temporalmente por varios intentos fallidos. Intenta nuevamente en 5 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
}));

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { ok: false, mensaje: 'Demasiados archivos subidos. Espera un momento.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/ventas/:id/audio', uploadLimiter);
app.use('/api/ventas/:id/fotos', uploadLimiter);

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// Ruta protegida para archivos — requiere token JWT válido
const UPLOADS_DIR = path.resolve(path.join(__dirname, 'uploads'));
app.get('/uploads/*', auth([]), (req, res) => {
  const relativePath = req.params[0];
  const filePath = path.resolve(path.join(UPLOADS_DIR, relativePath));

  // Prevenir path traversal
  if (!filePath.startsWith(UPLOADS_DIR + path.sep)) {
    return res.status(403).json({ ok: false, mensaje: 'Acceso denegado' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ ok: false, mensaje: 'Archivo no encontrado' });
  }

  res.sendFile(filePath);
});

app.use('/api', require('./routes/auth'));
app.use('/api/usuarios', require('./routes/usuarios'));
app.use('/api/ventas', require('./routes/ventas'));
app.use('/api/frases', require('./routes/frases'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/leads-reclutamiento', require('./routes/leads-reclutamiento'));
app.use('/api/ventas-reclutamiento', require('./routes/ventas-reclutamiento'));
app.use('/api/eliminaciones', require('./routes/eliminaciones'));

const db = require('./database');
app.get('/api/health', auth([]), async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true, mensaje: 'API corriendo', db: 'conectada' });
  } catch(e) {
    res.status(500).json({ ok: false, mensaje: 'BD desconectada' });
  }
});

app.use((req, res) => res.status(404).json({ ok: false, mensaje: 'Ruta no encontrada' }));
app.use((err, req, res, next) => {
  console.error('[' + new Date().toISOString() + '] ERROR:', err.message);
  if (err.type === 'entity.too.large') return res.status(413).json({ ok: false, mensaje: 'Archivo demasiado grande' });
  res.status(500).json({ ok: false, mensaje: 'Error interno' });
});

process.on('uncaughtException',    (err) => console.error('[UNCAUGHT]', err.message));
process.on('unhandledRejection',   (r)   => console.error('[UNHANDLED]', r));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Netcontact API puerto ' + PORT));
