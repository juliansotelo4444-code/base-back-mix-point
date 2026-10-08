const express = require('express');
const { requireAuth } = require('../middleware/auth');
const JarvisService = require('../services/jarvisService');
const { PERSONALIDADES } = require('../services/personalidadesService');
const MixPointMCPServer = require('../services/mcpServer');

const router = express.Router();
router.use(requireAuth);

const mcpServerInstance = new MixPointMCPServer();

/**
 * Consulta conversacional con el Agente IA
 * Soporta personalidades: yoda, baymax, jarvis, wally, c3po
 * Conexión MCP de solo lectura y memoria extendida
 */
router.post('/chat', async (req, res, next) => {
    try {
        const { mensaje, personalidad = 'jarvis' } = req.body;
        if (!mensaje || !mensaje.trim()) {
            return res.status(400).json({ error: 'El mensaje es requerido.' });
        }

        const respuesta = await JarvisService.responderConsulta(mensaje, { personalidad, mcp: mcpServerInstance });
        res.json({ ok: true, personalidad, ...respuesta });
    } catch (err) {
        next(err);
    }
});

/**
 * Endpoint para obtener el listado de personalidades disponibles
 */
router.get('/personalidades', (req, res) => {
    res.json({
        ok: true,
        personalidades: Object.values(PERSONALIDADES)
    });
});

/**
 * Consulta de herramientas MCP de forma directa (protocolo MCP)
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
            default:
                return res.status(400).json({ error: `Herramienta MCP desconocida: ${name}` });
        }
        res.json({ ok: true, resultado });
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
            '¿Cuánto stock tenemos de almendras y nueces?',
            'Analizar alertas críticas y quiebres de stock',
            'Consultar memoria del negocio y clientes morosos',
            '¿Quiénes son nuestros mayores deudores?',
            '¿Podemos elaborar 50 kg de Mix Tropical?'
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
