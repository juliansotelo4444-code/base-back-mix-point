const express = require('express');
const { requireAuth } = require('../middleware/auth');
const JarvisService = require('../services/jarvisService');

const router = express.Router();
router.use(requireAuth);

/**
 * Consulta conversacional con Jarvis (Texto o Voz transcrita)
 */
router.post('/chat', async (req, res, next) => {
    try {
        const { mensaje } = req.body;
        if (!mensaje || !mensaje.trim()) {
            return res.status(400).json({ error: 'El mensaje es requerido.' });
        }

        const respuesta = await JarvisService.responderConsulta(mensaje);
        res.json({ ok: true, ...respuesta });
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
            '¿Cuánto stock tenemos de almendras y nueces?',
            '¿Quiénes son nuestros mayores deudores?',
            '¿Podemos elaborar 50 kg de Mix Tropical?',
            '¿Cuánto facturamos hoy en remitos?',
            '¿Qué productos tienen stock crítico o agotado?',
            '¿Cómo viene el flujo de caja del mes?',
            '¿Qué productos tienen predicción de quiebre de stock?'
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
