const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const MercadoPagoService = require('../services/mercadopagoService');

const router = express.Router();

/**
 * Endpoints públicos para Webhook / IPN de Mercado Pago
 */
router.get('/webhook', (req, res) => {
    res.status(200).json({ ok: true, status: 'Webhook Mercado Pago activo' });
});

router.post('/webhook', async (req, res) => {
    try {
        const resultado = await MercadoPagoService.procesarWebhook(req.body, req.query);
        res.status(200).json(resultado);
    } catch (err) {
        console.error('[MercadoPago Webhook] Error:', err.message);
        // Responder 200 igualmente para evitar reintentos infinitos de Mercado Pago ante errores de datos
        res.status(200).json({ ok: false, error: err.message });
    }
});

// Rutas autenticadas
router.use(requireAuth);

/**
 * Consulta pagos aprobados recientes en vivo (accesible para repartidor, ventas, administracion y admin)
 * Nunca expone credenciales.
 */
router.get('/pagos-recientes', async (req, res, next) => {
    try {
        const horas = Number(req.query.horas) || 24;
        const limite = Number(req.query.limite) || 30;
        const data = await MercadoPagoService.obtenerPagosRecientes({ horas, limite });
        res.json(data);
    } catch (err) {
        next(err);
    }
});

/**
 * Confirma e imputa un pago verificado de Mercado Pago a un remito específico
 * (Restringido a admin, administracion y ventas; repartidor es solo lectura)
 */
router.post('/confirmar-pago-remito', requireRole('admin', 'administracion', 'ventas'), async (req, res, next) => {
    try {
        const { remito_id, payment } = req.body;
        if (!remito_id || !payment) {
            return res.status(400).json({ error: 'remito_id y payment son requeridos.' });
        }

        const resultado = await MercadoPagoService.confirmarPagoEnRemito({
            remito_id,
            payment,
            usuario_id: req.usuario?.id || null
        });
        res.json(resultado);
    } catch (err) {
        next(err);
    }
});

/**
 * Obtener configuración actual de Mercado Pago (solo admin / administracion)
 */
router.get('/config', requireRole('admin', 'administracion'), async (req, res, next) => {
    try {
        const cfg = await MercadoPagoService.obtenerConfig({ incluirToken: false });
        res.json(cfg);
    } catch (err) {
        next(err);
    }
});

/**
 * Guardar credenciales y opciones de Mercado Pago (solo admin / administracion)
 */
router.post('/config', requireRole('admin', 'administracion'), async (req, res, next) => {
    try {
        const { access_token, auto_sync, limpiar_token } = req.body;
        const cfg = await MercadoPagoService.guardarConfig({ access_token, auto_sync, limpiar_token });

        let prueba = null;
        if (access_token && !String(access_token).includes('****') && !limpiar_token) {
            prueba = await MercadoPagoService.probarConexion(access_token);
        }

        const cfgActualizada = await MercadoPagoService.obtenerConfig({ incluirToken: false });
        res.json({
            ok: true,
            config: cfgActualizada,
            prueba
        });
    } catch (err) {
        next(err);
    }
});

/**
 * Probar conexión con Mercado Pago (/users/me)
 */
router.post('/probar-conexion', requireRole('admin', 'administracion'), async (req, res, next) => {
    try {
        const resultado = await MercadoPagoService.probarConexion(req.body?.access_token || null);
        res.json(resultado);
    } catch (err) {
        next(err);
    }
});

/**
 * Sincronizar manualmente cobros recientes hacia Conciliación Bancaria
 */
router.post('/sincronizar', requireRole('admin', 'administracion', 'ventas'), async (req, res, next) => {
    try {
        const dias = Number(req.body?.dias) || 7;
        const resultado = await MercadoPagoService.sincronizarMovimientos({ dias, silencioso: false });
        res.json(resultado);
    } catch (err) {
        next(err);
    }
});

/**
 * Genera un Link de Pago / QR dinámico en Mercado Pago vinculado al remito
 */
router.post('/link-pago-remito', requireRole('admin', 'administracion', 'ventas'), async (req, res, next) => {
    try {
        const { remito_id } = req.body;
        if (!remito_id) {
            return res.status(400).json({ error: 'remito_id es requerido.' });
        }
        const hostUrl = req.get('host') ? `${req.protocol}://${req.get('host')}` : '';
        const backendUrl = process.env.BACKEND_PUBLIC_URL || hostUrl;
        const resultado = await MercadoPagoService.crearLinkPagoRemito({
            remito_id,
            backend_url: backendUrl
        });
        res.json(resultado);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
