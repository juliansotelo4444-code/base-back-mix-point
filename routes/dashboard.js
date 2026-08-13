const express = require('express');
const db = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/resumen', async (req, res, next) => {
    try {
        const inicioMes = new Date();
        inicioMes.setDate(1);
        const inicioMesStr = inicioMes.toISOString().slice(0, 10);

        const ventasMes = await db.one(`
            SELECT COALESCE(SUM(total), 0) as total, COUNT(*)::int as cantidad
            FROM remitos WHERE fecha >= $1 AND estado != 'anulado'
        `, [inicioMesStr]);

        const gastosMes = await db.one(`
            SELECT COALESCE(SUM(monto), 0) as total, COUNT(*)::int as cantidad
            FROM gastos WHERE fecha >= $1
        `, [inicioMesStr]);

        const comprasMes = await db.one(`
            SELECT COALESCE(SUM(total), 0) as total, COUNT(*)::int as cantidad
            FROM recepciones WHERE fecha >= $1 AND estado != 'anulada'
        `, [inicioMesStr]);

        const remitosPendientes = await db.one(`
            SELECT COUNT(*)::int as cantidad FROM remitos WHERE estado = 'pendiente'
        `);

        const productosBajoStock = await db.all(`
            SELECT id, nombre, stock_actual, stock_minimo, unidad_medida
            FROM productos WHERE activo = true AND stock_actual <= stock_minimo
            ORDER BY stock_actual ASC
        `);

        const lotesPorVencer = await db.all(`
            SELECT l.id, l.numero_lote, l.fecha_vencimiento, l.cantidad_actual, p.nombre as producto_nombre, p.unidad_medida
            FROM lotes l JOIN productos p ON p.id = l.producto_id
            WHERE l.cantidad_actual > 0 AND l.fecha_vencimiento IS NOT NULL
              AND l.fecha_vencimiento <= CURRENT_DATE + INTERVAL '30 days'
            ORDER BY l.fecha_vencimiento ASC
        `);

        const valorStock = await db.one(`
            SELECT COALESCE(SUM(stock_actual * precio_compra), 0) as total FROM productos WHERE activo = true
        `);

        res.json({
            ventas_mes: ventasMes,
            compras_mes: comprasMes,
            gastos_mes: gastosMes,
            remitos_pendientes: remitosPendientes.cantidad,
            productos_bajo_stock: productosBajoStock,
            lotes_por_vencer: lotesPorVencer,
            valor_stock_actual: valorStock.total
        });
    } catch (err) { next(err); }
});

router.get('/evolucion-mensual', async (req, res, next) => {
    try {
        const ventas = await db.all(`
            SELECT TO_CHAR(fecha, 'YYYY-MM') as mes, COALESCE(SUM(total),0) as total
            FROM remitos WHERE estado != 'anulado' AND fecha >= CURRENT_DATE - INTERVAL '6 months'
            GROUP BY mes ORDER BY mes ASC
        `);

        const gastos = await db.all(`
            SELECT TO_CHAR(fecha, 'YYYY-MM') as mes, COALESCE(SUM(monto),0) as total
            FROM gastos WHERE fecha >= CURRENT_DATE - INTERVAL '6 months'
            GROUP BY mes ORDER BY mes ASC
        `);

        const compras = await db.all(`
            SELECT TO_CHAR(fecha, 'YYYY-MM') as mes, COALESCE(SUM(total),0) as total
            FROM recepciones WHERE estado != 'anulada' AND fecha >= CURRENT_DATE - INTERVAL '6 months'
            GROUP BY mes ORDER BY mes ASC
        `);

        res.json({ ventas, gastos, compras });
    } catch (err) { next(err); }
});

router.get('/gastos-por-categoria', async (req, res, next) => {
    try {
        const { desde, hasta } = req.query;
        let sql = `
            SELECT cg.nombre as categoria, COALESCE(SUM(g.monto),0) as total
            FROM gastos g JOIN categorias_gasto cg ON cg.id = g.categoria_id
            WHERE 1=1
        `;
        const params = [];
        if (desde) { params.push(desde); sql += ` AND g.fecha >= $${params.length}`; }
        if (hasta) { params.push(hasta); sql += ` AND g.fecha <= $${params.length}`; }
        sql += ' GROUP BY cg.nombre ORDER BY total DESC';

        res.json(await db.all(sql, params));
    } catch (err) { next(err); }
});

router.get('/productos-mas-vendidos', async (req, res, next) => {
    try {
        const { desde, hasta, limite } = req.query;
        let sql = `
            SELECT p.id, p.nombre, p.unidad_medida, SUM(ri.cantidad) as cantidad_total, SUM(ri.subtotal) as total_facturado
            FROM remito_items ri
            JOIN remitos r ON r.id = ri.remito_id
            JOIN productos p ON p.id = ri.producto_id
            WHERE r.estado != 'anulado'
        `;
        const params = [];
        if (desde) { params.push(desde); sql += ` AND r.fecha >= $${params.length}`; }
        if (hasta) { params.push(hasta); sql += ` AND r.fecha <= $${params.length}`; }
        sql += ` GROUP BY p.id, p.nombre, p.unidad_medida ORDER BY cantidad_total DESC LIMIT $${params.length + 1}`;
        params.push(Number(limite) || 10);

        res.json(await db.all(sql, params));
    } catch (err) { next(err); }
});

module.exports = router;
