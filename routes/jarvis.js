const express = require('express');
const { requireAuth } = require('../middleware/auth');
const JarvisService = require('../services/jarvisService');
const MixPointMCPServer = require('../services/mcpServer');

const router = express.Router();
router.use(requireAuth);

const mcpServerInstance = new MixPointMCPServer();

/**
 * Consulta conversacional inteligente con J.A.R.V.I.S.
 * Conexión MCP de solo lectura, memoria extendida y automatización de remitos.
 */
router.post('/chat', async (req, res, next) => {
    try {
        const { mensaje } = req.body;
        if (!mensaje || !mensaje.trim()) {
            return res.status(400).json({ error: 'El mensaje es requerido.' });
        }

        const respuesta = await JarvisService.responderConsulta(mensaje, { mcp: mcpServerInstance });
        res.json({ ok: true, ...respuesta });
    } catch (err) {
        next(err);
    }
});

/**
 * Consulta de herramientas MCP directas
 */
router.post('/mcp/call-tool', async (req, res, next) => {
    try {
        const { name, arguments: args } = req.body;
        let resultado;
        switch (name) {
            case 'obtener_datos_pedido':
                resultado = await mcpServerInstance.toolObtenerDatosPedido(args);
                break;
            case 'consultar_stock_productos':
                resultado = await mcpServerInstance.toolConsultarStock(args);
                break;
            case 'consultar_memoria_negocio':
                resultado = await mcpServerInstance.toolConsultarMemoria(args);
                break;
            case 'guardar_memoria_negocio':
                resultado = await mcpServerInstance.toolGuardarMemoria(args);
                break;
            case 'monitorear_alertas_sistema':
                resultado = await mcpServerInstance.toolMonitorearAlertas(args);
                break;
            case 'verificar_y_generar_remito':
                resultado = await mcpServerInstance.toolGenerarRemito(args);
                break;
            case 'consultar_usuarios_conectados':
                resultado = await mcpServerInstance.toolConsultarUsuariosConectados(args);
                break;
            case 'consultar_persona_en_red':
                resultado = await mcpServerInstance.toolConsultarPersonaEnRed(args);
                break;
            case 'buscar_en_internet':
                resultado = await mcpServerInstance.toolBuscarEnInternet(args);
                break;
            default:
                return res.status(400).json({ error: `Herramienta MCP desconocida: ${name}` });
        }
        res.json({ ok: true, resultado });
    } catch (err) {
        next(err);
    }
});

/**
 * Endpoint para obtener personas conectadas a la red
 */
router.get('/usuarios-conectados', async (req, res, next) => {
    try {
        const { getUsuariosConectados } = require('../socket');
        const online = getUsuariosConectados ? getUsuariosConectados() : [];
        res.json({ ok: true, online });
    } catch (err) {
        next(err);
    }
});

/**
 * Consultas que Jarvis le hizo a personas del equipo
 */
router.get('/consultas-equipo', async (req, res, next) => {
    try {
        const db = require('../db/pool');
        const consultas = await db.all(`
            SELECT * FROM jarvis_consultas_equipo
            ORDER BY created_at DESC
            LIMIT 20
        `);
        res.json({ ok: true, consultas });
    } catch (err) {
        next(err);
    }
});

/**
 * Responder una consulta de Jarvis dirigida al usuario actual
 */
router.post('/consultas-equipo/:id/responder', async (req, res, next) => {
    try {
        const { respuesta } = req.body;
        if (!respuesta || !respuesta.trim()) {
            return res.status(400).json({ error: 'La respuesta es requerida.' });
        }
        const db = require('../db/pool');
        const { getIO } = require('../socket');

        await db.run(`
            UPDATE jarvis_consultas_equipo
            SET respuesta = $1, estado = 'respondida', answered_at = NOW()
            WHERE id = $2
        `, [respuesta.trim(), req.params.id]);

        const actualizada = await db.one('SELECT * FROM jarvis_consultas_equipo WHERE id = $1', [req.params.id]);
        const io = getIO ? getIO() : null;
        if (io) {
            io.emit('jarvis:consulta_respondida', actualizada);
        }

        res.json({ ok: true, consulta: actualizada });
    } catch (err) {
        next(err);
    }
});

/**
 * Endpoint para monitoreo de alertas automáticas
 */
router.get('/alertas-monitoreo', async (req, res, next) => {
    try {
        const alertas = await mcpServerInstance.toolMonitorearAlertas({ nivel_urgencia: req.query.nivel || 'todas' });
        res.json({ ok: true, data: JSON.parse(alertas.content[0].text) });
    } catch (err) {
        next(err);
    }
});

/**
 * Sugerencias de consultas rápidas para el dashboard
 */
router.get('/sugerencias', (req, res) => {
    res.json({
        sugerencias: [
            'Generar remito automático para el pedido MP-1001',
            '¿Qué productos tienen predicción de quiebre de stock?',
            'Monitorear alertas críticas del sistema',
            '¿Cuánto stock tenemos de almendras y nueces?',
            '¿Quiénes son nuestros mayores deudores?',
            'Resumen de facturación de hoy'
        ]
    });
});

/**
 * Predicción de quiebre de stock por consumo proyectado
 */
router.get('/prediccion-stock', async (req, res, next) => {
    try {
        const limite = parseInt(req.query.limite) || 20;
        const predicciones = await JarvisService.predecirQuiebreStock({ limite });
        res.json({ ok: true, predicciones });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
