const express = require('express');
const db = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/**
 * Calcula las fechas límite de hoy, mes calendario actual y 6 meses calendario atrás
 * en la zona horaria oficial de Argentina (evita desfases UTC después de las 21:00 ART).
 */
function getRangoMesArgentina() {
    const hoyStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Argentina/Buenos_Aires',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());

    const [anioStr, mesStr] = hoyStr.split('-');
    const anio = Number(anioStr);
    const mes = Number(mesStr);

    const inicioMesStr = `${anioStr}-${mesStr}-01`;
    const nextAnio = mes === 12 ? anio + 1 : anio;
    const nextMes = mes === 12 ? 1 : mes + 1;
    const inicioMesSiguienteStr = `${nextAnio}-${String(nextMes).padStart(2, '0')}-01`;

    const totalMesesAtras = anio * 12 + (mes - 1) - 5;
    const anio6 = Math.floor(totalMesesAtras / 12);
    const mes6 = (totalMesesAtras % 12) + 1;
    const inicio6MesesStr = `${anio6}-${String(mes6).padStart(2, '0')}-01`;

    return {
        hoyStr,
        inicioMesStr,
        inicioMesSiguienteStr,
        inicio6MesesStr
    };
}

router.get('/resumen', async (req, res, next) => {
    try {
        const { hoyStr, inicioMesStr, inicioMesSiguienteStr } = getRangoMesArgentina();

        const ventasMes = await db.one(`
            SELECT COALESCE(SUM(total), 0)::float as total, COUNT(*)::int as cantidad
            FROM remitos
            WHERE fecha >= $1 AND fecha < $2 AND estado NOT IN ('anulado', 'cancelado')
        `, [inicioMesStr, inicioMesSiguienteStr]);

        const gastosMes = await db.one(`
            SELECT COALESCE(SUM(monto), 0)::float as total, COUNT(*)::int as cantidad
            FROM gastos
            WHERE fecha >= $1 AND fecha < $2
        `, [inicioMesStr, inicioMesSiguienteStr]);

        const comprasMes = await db.one(`
            SELECT COALESCE(SUM(total), 0)::float as total, COUNT(*)::int as cantidad
            FROM recepciones
            WHERE fecha >= $1 AND fecha < $2 AND estado != 'anulada'
        `, [inicioMesStr, inicioMesSiguienteStr]);

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
            SELECT COALESCE(SUM(stock_actual * precio_compra), 0)::float as total FROM productos WHERE activo = true
        `);

        const estadosPedidos = await db.all(`
            SELECT estado, COUNT(*)::int as cantidad, COALESCE(SUM(total), 0)::float as total
            FROM remitos
            WHERE fecha >= $1 AND fecha < $2
            GROUP BY estado
        `, [inicioMesStr, inicioMesSiguienteStr]);

        const estadosPedidosHoy = await db.all(`
            SELECT estado, COUNT(*)::int as cantidad, COALESCE(SUM(total), 0)::float as total
            FROM remitos
            WHERE fecha::date = $1::date
            GROUP BY estado
        `, [hoyStr]);

        const pedidosHoyInfo = await db.one(`
            SELECT COUNT(*)::int as cantidad, COALESCE(SUM(total), 0)::float as total
            FROM remitos
            WHERE fecha::date = $1::date AND estado NOT IN ('anulado', 'cancelado')
        `, [hoyStr]);

        const balanceMes = Number((
            (Number(ventasMes?.total) || 0) -
            (Number(comprasMes?.total) || 0) -
            (Number(gastosMes?.total) || 0)
        ).toFixed(2));

        res.json({
            ventas_mes: ventasMes,
            compras_mes: comprasMes,
            gastos_mes: gastosMes,
            balance_mes: balanceMes,
            remitos_pendientes: remitosPendientes.cantidad,
            productos_bajo_stock: productosBajoStock,
            lotes_por_vencer: lotesPorVencer,
            valor_stock_actual: valorStock.total,
            estados_pedidos: estadosPedidos,
            estados_pedidos_hoy: estadosPedidosHoy,
            pedidos_hoy: pedidosHoyInfo.cantidad,
            pedidos_hoy_info: pedidosHoyInfo
        });
    } catch (err) { next(err); }
});

router.get('/evolucion-mensual', async (req, res, next) => {
    try {
        const { inicio6MesesStr } = getRangoMesArgentina();

        const ventas = await db.all(`
            SELECT TO_CHAR(fecha, 'YYYY-MM') as mes, COALESCE(SUM(total), 0)::float as total
            FROM remitos WHERE estado NOT IN ('anulado', 'cancelado') AND fecha >= $1
            GROUP BY mes ORDER BY mes ASC
        `, [inicio6MesesStr]);

        const gastos = await db.all(`
            SELECT TO_CHAR(fecha, 'YYYY-MM') as mes, COALESCE(SUM(monto), 0)::float as total
            FROM gastos WHERE fecha >= $1
            GROUP BY mes ORDER BY mes ASC
        `, [inicio6MesesStr]);

        const compras = await db.all(`
            SELECT TO_CHAR(fecha, 'YYYY-MM') as mes, COALESCE(SUM(total), 0)::float as total
            FROM recepciones WHERE estado != 'anulada' AND fecha >= $1
            GROUP BY mes ORDER BY mes ASC
        `, [inicio6MesesStr]);

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
            WHERE r.estado NOT IN ('anulado', 'cancelado')
        `;
        const params = [];
        if (desde) { params.push(desde); sql += ` AND r.fecha >= $${params.length}`; }
        if (hasta) { params.push(hasta); sql += ` AND r.fecha <= $${params.length}`; }
        sql += ` GROUP BY p.id, p.nombre, p.unidad_medida ORDER BY cantidad_total DESC LIMIT $${params.length + 1}`;
        params.push(Number(limite) || 10);

        res.json(await db.all(sql, params));
    } catch (err) { next(err); }
});

/**
 * Análisis de Rentabilidad Real del mes en curso (margen real sobre costo, top productos/clientes y alertas < 15%)
 */
router.get('/rentabilidad', requireRole('admin', 'administracion', 'ventas'), async (req, res, next) => {
    try {
        const { inicioMesStr, inicioMesSiguienteStr } = getRangoMesArgentina();

        const [ventasRow, costoRow, gastosRow, topProductos, topClientes, alertasMargen] = await Promise.all([
            db.one(`
                SELECT COALESCE(SUM(total), 0)::float as total
                FROM remitos
                WHERE fecha >= $1 AND fecha < $2 AND estado NOT IN ('anulado', 'cancelado')
            `, [inicioMesStr, inicioMesSiguienteStr]),
            db.one(`
                SELECT COALESCE(SUM(ri.cantidad * COALESCE(NULLIF(l.costo_unitario, 0), p.precio_compra, 0)), 0)::float as costo_total
                FROM remito_items ri
                JOIN remitos r ON r.id = ri.remito_id
                JOIN productos p ON p.id = ri.producto_id
                LEFT JOIN lotes l ON l.id = ri.lote_id
                WHERE r.fecha >= $1 AND r.fecha < $2 AND r.estado NOT IN ('anulado', 'cancelado')
            `, [inicioMesStr, inicioMesSiguienteStr]),
            db.one(`
                SELECT COALESCE(SUM(monto), 0)::float as total
                FROM gastos
                WHERE fecha >= $1 AND fecha < $2
            `, [inicioMesStr, inicioMesSiguienteStr]),
            db.all(`
                SELECT
                    p.id,
                    p.nombre,
                    p.unidad_medida,
                    COALESCE(SUM(ri.cantidad), 0)::float as cantidad,
                    COALESCE(SUM(ri.subtotal), 0)::float as facturado,
                    COALESCE(SUM(ri.cantidad * COALESCE(NULLIF(l.costo_unitario, 0), p.precio_compra, 0)), 0)::float as costo,
                    (COALESCE(SUM(ri.subtotal), 0) - COALESCE(SUM(ri.cantidad * COALESCE(NULLIF(l.costo_unitario, 0), p.precio_compra, 0)), 0))::float as ganancia,
                    CASE WHEN COALESCE(SUM(ri.subtotal), 0) > 0
                        THEN ROUND(((SUM(ri.subtotal) - SUM(ri.cantidad * COALESCE(NULLIF(l.costo_unitario, 0), p.precio_compra, 0))) / SUM(ri.subtotal)) * 100, 1)::float
                        ELSE 0
                    END as margen_pct
                FROM remito_items ri
                JOIN remitos r ON r.id = ri.remito_id
                JOIN productos p ON p.id = ri.producto_id
                LEFT JOIN lotes l ON l.id = ri.lote_id
                WHERE r.fecha >= $1 AND r.fecha < $2 AND r.estado NOT IN ('anulado', 'cancelado')
                GROUP BY p.id, p.nombre, p.unidad_medida
                ORDER BY ganancia DESC
                LIMIT 5
            `, [inicioMesStr, inicioMesSiguienteStr]),
            db.all(`
                SELECT
                    c.id,
                    c.razon_social,
                    COUNT(DISTINCT r.id)::int as pedidos,
                    COALESCE(SUM(ri.subtotal), 0)::float as facturado,
                    COALESCE(SUM(ri.cantidad * COALESCE(NULLIF(l.costo_unitario, 0), p.precio_compra, 0)), 0)::float as costo,
                    (COALESCE(SUM(ri.subtotal), 0) - COALESCE(SUM(ri.cantidad * COALESCE(NULLIF(l.costo_unitario, 0), p.precio_compra, 0)), 0))::float as ganancia,
                    CASE WHEN COALESCE(SUM(ri.subtotal), 0) > 0
                        THEN ROUND(((SUM(ri.subtotal) - SUM(ri.cantidad * COALESCE(NULLIF(l.costo_unitario, 0), p.precio_compra, 0))) / SUM(ri.subtotal)) * 100, 1)::float
                        ELSE 0
                    END as margen_pct
                FROM remito_items ri
                JOIN remitos r ON r.id = ri.remito_id
                JOIN clientes c ON c.id = r.cliente_id
                JOIN productos p ON p.id = ri.producto_id
                LEFT JOIN lotes l ON l.id = ri.lote_id
                WHERE r.fecha >= $1 AND r.fecha < $2 AND r.estado NOT IN ('anulado', 'cancelado')
                GROUP BY c.id, c.razon_social
                ORDER BY ganancia DESC
                LIMIT 5
            `, [inicioMesStr, inicioMesSiguienteStr]),
            db.all(`
                SELECT
                    id,
                    codigo,
                    nombre,
                    precio_compra::float,
                    precio_venta::float,
                    ROUND(((precio_venta - precio_compra) / NULLIF(precio_compra, 0)) * 100, 1)::float as margen_pct
                FROM productos
                WHERE activo = true
                  AND precio_compra > 0
                  AND precio_venta > 0
                  AND ((precio_venta - precio_compra) / precio_compra) * 100 < 15
                ORDER BY margen_pct ASC
                LIMIT 10
            `)
        ]);

        const ventas = Number(ventasRow?.total || 0);
        const costoMercaderia = Number(costoRow?.costo_total || 0);
        const gastos = Number(gastosRow?.total || 0);
        const gananciaBruta = Number((ventas - costoMercaderia).toFixed(2));
        const gananciaNetaEstimada = Number((gananciaBruta - gastos).toFixed(2));
        const margenBrutoPct = ventas > 0 ? Number(((gananciaBruta / ventas) * 100).toFixed(1)) : 0;

        res.json({
            ventas_mes: ventas,
            costo_mercaderia_vendida: costoMercaderia,
            gastos_mes: gastos,
            ganancia_bruta: gananciaBruta,
            ganancia_neta_estimada: gananciaNetaEstimada,
            margen_bruto_pct: margenBrutoPct,
            top_productos_rentables: topProductos,
            top_clientes_rentables: topClientes,
            alertas_margen_bajo: alertasMargen
        });
    } catch (err) { next(err); }
});

module.exports = router;
