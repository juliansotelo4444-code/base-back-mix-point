require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const db = require('./db/pool');
const { initSocket } = require('./socket');
const ReporteDiarioService = require('./services/reporteDiario');
const { sincronizarUnidireccional } = require('./services/googleSheets');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 4000;

// Inicializar Socket.io con el servidor HTTP
initSocket(server);

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
app.use('/api/audit-logs', require('./routes/auditLogs'));
app.use('/api/deposito', require('./routes/deposito'));

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

    // 3. J.A.R.V.I.S. Sentry Daemon (Monitoreo autónomo 24/7 de stock crítico y clientes inactivos)
    async function ejecutarSentryJarvis() {
        try {
            const JarvisService = require('./services/jarvisService');
            const { getIO } = require('./socket');

            // Quiebres de stock inminentes
            const predicciones = await JarvisService.predecirQuiebreStock({ limite: 5 });
            const criticos = predicciones.filter(p => p.alerta_quiebre);

            // Clientes clave inactivos (>20 días sin comprar con historial previo)
            const clientesInactivos = await db.all(`
                SELECT c.id, c.razon_social, MAX(r.fecha) as ultima_compra,
                       (CURRENT_DATE - MAX(r.fecha)::date) as dias_inactivo
                FROM clientes c
                JOIN remitos r ON r.cliente_id = c.id
                WHERE c.activo = true AND r.estado NOT IN ('cancelado', 'anulado')
                GROUP BY c.id, c.razon_social
                HAVING (CURRENT_DATE - MAX(r.fecha)::date) >= 20
                ORDER BY dias_inactivo DESC
                LIMIT 3
            `).catch(() => []);

            const hayAlertas = criticos.length > 0 || clientesInactivos.length > 0;
            if (hayAlertas) {
                const alertaPayload = {
                    tipo: 'sentry_autonomo',
                    timestamp: new Date().toISOString(),
                    quiebres_stock: criticos.map(c => ({
                        producto: c.nombre,
                        stock: c.stock_actual,
                        unidad: c.unidad,
                        dias_restantes: c.dias_restantes
                    })),
                    clientes_inactivos: clientesInactivos.map(ci => ({
                        cliente: ci.razon_social,
                        dias_inactivo: ci.dias_inactivo
                    }))
                };

                // Persistir en memoria extendida de Postgres
                await db.run(`
                    INSERT INTO agente_memoria (clave, contenido, updated_at)
                    VALUES ($1, $2, NOW())
                    ON CONFLICT (clave) DO UPDATE SET contenido = $2, updated_at = NOW()
                `, ['jarvis_sentry_ultimo_escaneo', JSON.stringify(alertaPayload)]).catch(() => {});

                // Notificar en tiempo real por Socket.io a terminales conectadas
                const io = getIO ? getIO() : null;
                if (io) {
                    io.emit('jarvis:alerta_proactiva', alertaPayload);
                }
                console.log(`🛡️ [J.A.R.V.I.S. Sentry Daemon] Escaneo completado: ${criticos.length} quiebres de stock, ${clientesInactivos.length} clientes inactivos.`);
            }
        } catch (errSentry) {
            console.error('[J.A.R.V.I.S. Sentry Daemon Error]:', errSentry.message);
        }
    }

    setTimeout(ejecutarSentryJarvis, 10000);
    setInterval(ejecutarSentryJarvis, 20 * 60 * 1000);

    console.log('⏰ Schedulers de Reporte Matutino (8:00 AM), Sync Sheets y J.A.R.V.I.S. Sentry Daemon (24/7) inicializados.');
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

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🥭 API de Mix Point corriendo en http://0.0.0.0:${PORT} (HTTP + WebSockets activo)`);
    });
}

start();
