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
            '¿Cómo viene el flujo de caja del mes?'
        ]
    });
});

module.exports = router;
