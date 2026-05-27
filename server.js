/* ================================================
   SERVER.JS — Servidor principal Netcontact
   ================================================ */
require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET','POST','PATCH','PUT','DELETE'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: false,
}));
app.use(express.json());

// Rutas
app.use('/api',          require('./routes/auth'));
app.use('/api/usuarios', require('./routes/usuarios'));
app.use('/api/ventas',   require('./routes/ventas'));
app.use('/api/frases',   require('./routes/frases'));
app.use('/api/leads',    require('./routes/leads'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, mensaje: 'Netcontact API corriendo', fecha: new Date().toISOString() });
});

// 404
app.use((req, res) => {
  res.status(404).json({ ok: false, mensaje: 'Ruta no encontrada' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Netcontact API corriendo en http://localhost:${PORT}`);
  console.log(`📋 Endpoints:`);
  console.log(`   POST   /api/login`);
  console.log(`   GET    /api/verificar`);
  console.log(`   GET    /api/usuarios`);
  console.log(`   POST   /api/usuarios`);
  console.log(`   PATCH  /api/usuarios/:id`);
  console.log(`   PATCH  /api/usuarios/:id/estado`);
  console.log(`   DELETE /api/usuarios/:id`);
  console.log(`   POST   /api/ventas`);
  console.log(`   GET    /api/ventas`);
  console.log(`   PATCH  /api/ventas/:id`);
  console.log(`   POST   /api/leads`);
  console.log(`   GET    /api/leads`);
  console.log(`   PATCH  /api/leads/:id`);
  console.log(`   DELETE /api/leads/:id\n`);
});