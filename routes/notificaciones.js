const express = require('express');
const { requireAuth } = require('../middleware/auth');
const db = require('../db/pool');
const AlertasService = require('../services/alertasService');

const router = express.Router();
router.use(requireAuth);

/**
 * Obtener notificaciones recientes y contador de no leídas
 */
router.get('/', async (req, res, next) => {
    try {
        const soloNoLeidas = req.query.solo_no_leidas === 'true';
        const limite = Math.min(parseInt(req.query.limite) || 30, 100);

        let queryStr = `
            SELECT * FROM notificaciones
            ${soloNoLeidas ? 'WHERE leida = false' : ''}
            ORDER BY created_at DESC
            LIMIT $1
        `;
        const notificaciones = await db.all(queryStr, [limite]);

        const noLeidasRow = await db.one(`
            SELECT COUNT(*)::int as count 
            FROM notificaciones 
            WHERE leida = false
        `);

        res.json({
            no_leidas: noLeidasRow ? noLeidasRow.count : 0,
            notificaciones
        });
    } catch (err) {
        next(err);
    }
});

/**
 * Marcar una notificación como leída
 */
router.put('/:id/leer', async (req, res, next) => {
    try {
        const { id } = req.params;
        await db.run('UPDATE notificaciones SET leida = true WHERE id = $1', [id]);
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

/**
 * Marcar todas las notificaciones como leídas
 */
router.post('/marcar-todas', async (req, res, next) => {
    try {
        await db.run('UPDATE notificaciones SET leida = true WHERE leida = false');
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

/**
 * Eliminar una notificación
 */
router.delete('/:id', async (req, res, next) => {
    try {
        const { id } = req.params;
        await db.run('DELETE FROM notificaciones WHERE id = $1', [id]);
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

/**
 * Forzar escaneo de stock en todos los productos activos
 */
router.post('/verificar-stock', async (req, res, next) => {
    try {
        const prods = await db.all('SELECT id FROM productos WHERE activo = true');
        for (const p of prods) {
            await AlertasService.verificarStockProducto(p.id);
        }
        res.json({ ok: true, verificados: prods.length });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
