const express = require('express');
const { requireAuth } = require('../middleware/auth');
const db = require('../db/pool');
const ConciliacionService = require('../services/conciliacionService');

const router = express.Router();
router.use(requireAuth);

/**
 * Obtener métricas de conciliación (totales y montos)
 */
router.get('/metricas', async (req, res, next) => {
    try {
        const metricas = await db.one(`
            SELECT
                COALESCE(SUM(CASE WHEN estado = 'pendiente' THEN monto ELSE 0 END), 0) as monto_pendiente,
                COUNT(CASE WHEN estado = 'pendiente' THEN 1 END)::int as cantidad_pendientes,
                COALESCE(SUM(CASE WHEN estado = 'conciliado' AND fecha_movimiento >= DATE_TRUNC('month', CURRENT_DATE) THEN monto ELSE 0 END), 0) as monto_conciliado_mes,
                COUNT(CASE WHEN estado = 'conciliado' AND fecha_movimiento >= DATE_TRUNC('month', CURRENT_DATE) THEN 1 END)::int as cantidad_conciliados_mes
            FROM conciliaciones_bancarias
        `);

        res.json(metricas);
    } catch (err) {
        next(err);
    }
});

/**
 * Listar movimientos de conciliación con filtros
 */
router.get('/', async (req, res, next) => {
    try {
        const { estado = 'pendiente', cuenta_origen, limit = 100 } = req.query;

        let query = `
            SELECT 
                cb.*,
                c.razon_social as cliente_nombre,
                c.saldo_cuenta as cliente_saldo,
                r.numero as remito_numero,
                r.total as remito_total
            FROM conciliaciones_bancarias cb
            LEFT JOIN clientes c ON c.id = cb.cliente_id
            LEFT JOIN remitos r ON r.id = cb.remito_id
            WHERE 1=1
        `;
        const params = [];

        if (estado && estado !== 'todos') {
            params.push(estado);
            query += ` AND cb.estado = $${params.length}`;
        }

        if (cuenta_origen) {
            params.push(cuenta_origen);
            query += ` AND cb.cuenta_origen = $${params.length}`;
        }

        query += ` ORDER BY cb.fecha_movimiento DESC, cb.id DESC LIMIT $${params.length + 1}`;
        params.push(Math.min(parseInt(limit) || 100, 300));

        const movimientos = await db.all(query, params);
        res.json(movimientos);
    } catch (err) {
        next(err);
    }
});

/**
 * Importar extracto bancario o de Mercado Pago (CSV o texto tabulado)
 */
router.post('/importar', async (req, res, next) => {
    try {
        const { contenido, cuenta_origen = 'mercadopago' } = req.body;
        if (!contenido || !contenido.trim()) {
            return res.status(400).json({ error: 'El contenido del extracto es requerido.' });
        }

        const movimientosParseados = ConciliacionService.parsearExtracto(contenido);
        if (movimientosParseados.length === 0) {
            return res.status(400).json({ error: 'No se encontraron movimientos válidos de crédito en el texto proporcionado.' });
        }

        const resultado = await ConciliacionService.importarYCruzar(movimientosParseados, cuenta_origen);
        res.status(201).json(resultado);
    } catch (err) {
        next(err);
    }
});

/**
 * Confirmar conciliación de un movimiento individual
 */
router.post('/conciliar', async (req, res, next) => {
    try {
        const { conciliacion_id, cliente_id, remito_id, observaciones } = req.body;
        if (!conciliacion_id) return res.status(400).json({ error: 'conciliacion_id es requerido.' });

        const resultado = await ConciliacionService.conciliar({
            conciliacion_id,
            cliente_id,
            remito_id,
            observaciones,
            usuario_id: req.usuario.id
        });

        res.json({ ok: true, movimiento: resultado });
    } catch (err) {
        next(err);
    }
});

/**
 * Conciliación masiva en 1 clic para sugerencias con alta certeza
 */
router.post('/conciliar-masivo', async (req, res, next) => {
    try {
        // Buscar pendientes que ya tienen cliente_id asignado y no tienen diferencia excesiva
        const pendientesConSugerencia = await db.all(`
            SELECT id, cliente_id, remito_id, monto, cuenta_origen, comprobante_nro
            FROM conciliaciones_bancarias
            WHERE estado = 'pendiente' AND cliente_id IS NOT NULL
        `);

        let conciladosCount = 0;
        const errores = [];

        for (const p of pendientesConSugerencia) {
            try {
                await ConciliacionService.conciliar({
                    conciliacion_id: p.id,
                    cliente_id: p.cliente_id,
                    remito_id: p.remito_id,
                    observaciones: `Conciliación automática masiva (${p.cuenta_origen})`,
                    usuario_id: req.usuario.id
                });
                conciladosCount++;
            } catch (err) {
                errores.push({ id: p.id, error: err.message });
            }
        }

        res.json({
            ok: true,
            total_procesados: pendientesConSugerencia.length,
            conciliados: conciladosCount,
            errores
        });
    } catch (err) {
        next(err);
    }
});

/**
 * Descartar un movimiento
 */
router.post('/descartar', async (req, res, next) => {
    try {
        const { conciliacion_id, motivo } = req.body;
        if (!conciliacion_id) return res.status(400).json({ error: 'conciliacion_id es requerido.' });

        const resultado = await ConciliacionService.descartar(conciliacion_id, motivo);
        res.json({ ok: true, movimiento: resultado });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
