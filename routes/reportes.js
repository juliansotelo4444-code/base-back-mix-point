const express = require('express');
const { requireAuth } = require('../middleware/auth');
const db = require('../db/pool');
const ReporteDiarioService = require('../services/reporteDiario');

const router = express.Router();
router.use(requireAuth);

/**
 * Previsualizar el reporte diario sin enviarlo
 */
router.get('/preview', async (req, res, next) => {
    try {
        const { fecha } = req.query;
        const datos = await ReporteDiarioService.generarDatosReporte(fecha || null);
        const texto = ReporteDiarioService.formatearMensaje(datos);
        res.json({ ok: true, datos, texto });
    } catch (err) {
        next(err);
    }
});

/**
 * Enviar manualmente el reporte ahora mismo
 */
router.post('/enviar', async (req, res, next) => {
    try {
        const { fecha } = req.body;
        const resultado = await ReporteDiarioService.enviarReporte(fecha || null);
        res.json(resultado);
    } catch (err) {
        next(err);
    }
});

/**
 * Obtener configuración de canales de notificación externa
 */
router.get('/config', async (req, res, next) => {
    try {
        const rows = await db.all(`
            SELECT clave, valor 
            FROM configuracion_sistema 
            WHERE clave IN ('telegram_bot_token', 'telegram_chat_id', 'reporte_webhook_url', 'alertas_webhook_url', 'ultimo_reporte_enviado')
        `);
        const cfg = {};
        rows.forEach(r => { cfg[r.clave] = r.valor; });

        res.json({
            telegram_bot_token: cfg.telegram_bot_token || '',
            telegram_chat_id: cfg.telegram_chat_id || '',
            reporte_webhook_url: cfg.reporte_webhook_url || '',
            alertas_webhook_url: cfg.alertas_webhook_url || '',
            ultimo_reporte_enviado: cfg.ultimo_reporte_enviado || null
        });
    } catch (err) {
        next(err);
    }
});

/**
 * Guardar configuración de canales de notificación externa
 */
router.post('/config', async (req, res, next) => {
    try {
        const { telegram_bot_token, telegram_chat_id, reporte_webhook_url, alertas_webhook_url } = req.body;

        const entries = [
            ['telegram_bot_token', telegram_bot_token],
            ['telegram_chat_id', telegram_chat_id],
            ['reporte_webhook_url', reporte_webhook_url],
            ['alertas_webhook_url', alertas_webhook_url]
        ];

        for (const [clave, valor] of entries) {
            if (valor !== undefined) {
                await db.run(`
                    INSERT INTO configuracion_sistema (clave, valor, updated_at)
                    VALUES ($1, $2, NOW())
                    ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()
                `, [clave, String(valor)]);
            }
        }

        res.json({ ok: true, mensaje: 'Configuración de canales guardada con éxito.' });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
