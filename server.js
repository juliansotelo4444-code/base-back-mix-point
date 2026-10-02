require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const db = require('./db/pool');
const ReporteDiarioService = require('./services/reporteDiario');
const { sincronizarUnidireccional } = require('./services/googleSheets');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));

app.get('/api/health', async (req, res) => {
    try {
        await db.query('SELECT 1');
        res.json({ ok: true, servicio: 'mix-point-api', db: 'conectada' });
    } catch (err) {
        res.status(500).json({ ok: false, error: 'No se pudo conectar a la base de datos.' });
    }
});

// Rutas Core
app.use('/api/auth', require('./routes/auth'));
app.use('/api/usuarios', require('./routes/usuarios'));
app.use('/api/clientes', require('./routes/clientes'));
app.use('/api/proveedores', require('./routes/proveedores'));
app.use('/api/productos', require('./routes/productos'));
app.use('/api/recepciones', require('./routes/recepciones'));
app.use('/api/remitos', require('./routes/remitos'));
app.use('/api/gastos', require('./routes/gastos'));
app.use('/api/cuenta-corriente', require('./routes/cuentaCorriente'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/integraciones', require('./routes/integraciones'));
app.use('/api/produccion', require('./routes/produccion'));

// Módulos Nuevos
app.use('/api/notificaciones', require('./routes/notificaciones'));
app.use('/api/conciliacion', require('./routes/conciliacion'));
app.use('/api/reportes', require('./routes/reportes'));
app.use('/api/jarvis', require('./routes/jarvis'));

// Servir frontend compilado y resolver 404 en recargas de rutas SPA
const path = require('path');
const fs = require('fs');
const distPath = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api')) return next();
        res.sendFile(path.join(distPath, 'index.html'));
    });
}

app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message || 'Error interno del servidor.' });
});

/**
 * Tareas programadas en segundo plano
 */
function iniciarTareasEnSegundoPlano() {
    // 1. Verificación de Reporte Diario (Chequeo cada 60s si son las 08:00 AM Argentina)
    setInterval(() => {
        ReporteDiarioService.verificarDisparoAutomatico().catch(err => {
            console.error('Error en scheduler de reporte diario:', err.message);
        });
    }, 60 * 1000);

    // 2. Sincronización periódica unidireccional con Google Sheets cada 10 minutos (Sheets -> Postgres)
    setInterval(() => {
        sincronizarUnidireccional().catch(err => {
            // Silencioso si no hay sheet o hay error temporal
            console.warn('[Sync Sheets Periódico]', err.message);
        });
    }, 10 * 60 * 1000);

    console.log('⏰ Schedulers de Reporte Matutino (8:00 AM) y Sincronización activa inicializados.');
}

async function start() {
    try {
        await db.initSchema();
        console.log('📦 Esquema de base de datos verificado/creado.');
    } catch (err) {
        console.error('❌ No se pudo inicializar la base de datos:', err.message);
        process.exit(1);
    }

    iniciarTareasEnSegundoPlano();

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🥭 API de Mix Point corriendo en http://0.0.0.0:${PORT}`);
    });
}

start();
