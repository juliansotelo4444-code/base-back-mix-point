const express = require('express');
const router = express.Router();
const db = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { generarNumero } = require('../utils/numerador');

router.use(requireAuth);

router.get('/', async (req, res, next) => {
    try {
        const { proveedor_id, desde, hasta, estado } = req.query;
        let sql = `
            SELECT r.*, p.razon_social as proveedor_nombre
            FROM recepciones r
            JOIN proveedores p ON p.id = r.proveedor_id
            WHERE 1=1
        `;
        const params = [];
        if (proveedor_id) { params.push(proveedor_id); sql += ` AND r.proveedor_id = $${params.length}`; }
        if (desde) { params.push(desde); sql += ` AND r.fecha >= $${params.length}`; }
        if (hasta) { params.push(hasta); sql += ` AND r.fecha <= $${params.length}`; }
        if (estado) { params.push(estado); sql += ` AND r.estado = $${params.length}`; }
        sql += ' ORDER BY r.fecha DESC, r.id DESC';

        res.json(await db.all(sql, params));
    } catch (err) { next(err); }
});

/**
 * Consulta de ingresos de mercadería por producto con el costo pagado,
 * historial de proveedores, lotes y métricas de costos (último, promedio ponderado, mín, máx).
 */
router.get('/historial-producto', async (req, res, next) => {
    try {
        const { producto_id, q, proveedor_id, desde, hasta } = req.query;
        let sql = `
            SELECT 
                ri.id as item_id,
                ri.recepcion_id,
                r.numero as recepcion_numero,
                r.fecha,
                r.estado as recepcion_estado,
                r.numero_remito_proveedor,
                r.numero_factura,
                r.observaciones as recepcion_observaciones,
                p.id as proveedor_id,
                p.razon_social as proveedor_nombre,
                pr.id as producto_id,
                pr.codigo as producto_codigo,
                pr.nombre as producto_nombre,
                pr.unidad_medida,
                pr.stock_actual,
                pr.precio_compra as producto_costo_actual,
                pr.precio_venta as producto_precio_venta,
                ri.cantidad,
                ri.precio_unitario as costo_unitario_pagado,
                ri.subtotal,
                l.numero_lote,
                l.fecha_vencimiento,
                l.cantidad_actual as lote_stock_remanente
            FROM recepcion_items ri
            JOIN recepciones r ON r.id = ri.recepcion_id
            JOIN proveedores p ON p.id = r.proveedor_id
            JOIN productos pr ON pr.id = ri.producto_id
            LEFT JOIN lotes l ON l.id = ri.lote_id
            WHERE r.estado != 'anulada'
        `;
        const params = [];
        if (producto_id) {
            params.push(Number(producto_id));
            sql += ` AND pr.id = $${params.length}`;
        }
        if (q) {
            params.push(`%${q}%`, `%${q}%`);
            sql += ` AND (pr.nombre ILIKE $${params.length - 1} OR pr.codigo ILIKE $${params.length})`;
        }
        if (proveedor_id) {
            params.push(Number(proveedor_id));
            sql += ` AND p.id = $${params.length}`;
        }
        if (desde) {
            params.push(desde);
            sql += ` AND r.fecha >= $${params.length}`;
        }
        if (hasta) {
            params.push(hasta);
            sql += ` AND r.fecha <= $${params.length}`;
        }

        sql += ' ORDER BY r.fecha DESC, ri.id DESC LIMIT 400';

        const items = await db.all(sql, params);

        let totalCantidad = 0;
        let totalInvertido = 0;
        let ultimoCosto = 0;
        let costoMin = null;
        let costoMax = null;

        if (items.length > 0) {
            ultimoCosto = Number(items[0].costo_unitario_pagado) || 0;
            for (const it of items) {
                const cant = Number(it.cantidad) || 0;
                const cost = Number(it.costo_unitario_pagado) || 0;
                const sub = Number(it.subtotal) || (cant * cost);
                totalCantidad += cant;
                totalInvertido += sub;
                if (costoMin === null || cost < costoMin) costoMin = cost;
                if (costoMax === null || cost > costoMax) costoMax = cost;
            }
        }

        const costoPromedioPonderado = totalCantidad > 0 ? (totalInvertido / totalCantidad) : 0;

        res.json({
            items,
            metricas: {
                total_ingresos: items.length,
                total_cantidad: Math.round(totalCantidad * 100) / 100,
                total_invertido: Math.round(totalInvertido * 100) / 100,
                ultimo_costo: ultimoCosto,
                costo_promedio: Math.round(costoPromedioPonderado * 100) / 100,
                costo_minimo: costoMin || 0,
                costo_maximo: costoMax || 0
            }
        });
    } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
    try {
        const recepcion = await db.one(`
            SELECT r.*, p.razon_social as proveedor_nombre FROM recepciones r
            JOIN proveedores p ON p.id = r.proveedor_id WHERE r.id = $1
        `, [req.params.id]);
        if (!recepcion) return res.status(404).json({ error: 'Recepción no encontrada.' });

        const items = await db.all(`
            SELECT ri.*, pr.nombre as producto_nombre, pr.unidad_medida
            FROM recepcion_items ri JOIN productos pr ON pr.id = ri.producto_id
            WHERE ri.recepcion_id = $1
        `, [req.params.id]);

        res.json({ ...recepcion, items });
    } catch (err) { next(err); }
});

/**
 * Crear recepción de mercadería. Cada ítem genera un lote nuevo y suma stock.
 */
router.post('/', async (req, res, next) => {
    try {
        const { proveedor_id, fecha, numero_remito_proveedor, numero_factura, observaciones, items } = req.body;

        if (!proveedor_id) return res.status(400).json({ error: 'proveedor_id es requerido.' });
        if (!items || !items.length) return res.status(400).json({ error: 'Debe incluir al menos un ítem.' });

        const recepcionId = await db.transaction(async (tx) => {
            const numero = await generarNumero('recepciones', 'REC', tx);
            const total = items.reduce((acc, it) => acc + (it.cantidad * it.precio_unitario), 0);

            const { row } = await tx.run(`
                INSERT INTO recepciones (numero, proveedor_id, fecha, numero_remito_proveedor, numero_factura, observaciones, total, usuario_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
            `, [numero, proveedor_id, fecha || new Date().toISOString().slice(0, 10), numero_remito_proveedor || null, numero_factura || null, observaciones || null, total, req.usuario.id]);

            const recepcionId = row.id;

            for (const item of items) {
                const { row: lote } = await tx.run(`
                    INSERT INTO lotes (producto_id, numero_lote, proveedor_id, fecha_ingreso, fecha_vencimiento, cantidad_inicial, cantidad_actual, costo_unitario, recepcion_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8) RETURNING id
                `, [item.producto_id, item.numero_lote || null, proveedor_id, fecha || new Date().toISOString().slice(0, 10), item.fecha_vencimiento || null, item.cantidad, item.precio_unitario || 0, recepcionId]);

                await tx.run(`
                    INSERT INTO recepcion_items (recepcion_id, producto_id, lote_id, cantidad, precio_unitario, subtotal)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [recepcionId, item.producto_id, lote.id, item.cantidad, item.precio_unitario || 0, item.cantidad * (item.precio_unitario || 0)]);

                await tx.run('UPDATE productos SET stock_actual = stock_actual + $1, precio_compra = $2 WHERE id = $3',
                    [item.cantidad, item.precio_unitario || 0, item.producto_id]);

                await tx.run(`
                    INSERT INTO movimientos_stock (producto_id, lote_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
                    VALUES ($1, $2, 'ingreso', $3, 'Recepción de mercadería', 'recepcion', $4, $5)
                `, [item.producto_id, lote.id, item.cantidad, recepcionId, req.usuario.id]);
            }

            // Actualizar cuenta corriente del proveedor si la recepción tiene monto
            if (Number(total) > 0) {
                await tx.run('UPDATE proveedores SET saldo_cuenta = saldo_cuenta + $1 WHERE id = $2', [total, proveedor_id]);
                await tx.run(`
                    INSERT INTO movimientos_cuenta (entidad_tipo, entidad_id, tipo, monto, medio_pago, referencia_tipo, referencia_id, observaciones, usuario_id)
                    VALUES ('proveedor', $1, 'cargo', $2, 'cuenta_corriente', 'recepcion', $3, $4, $5)
                `, [proveedor_id, total, recepcionId, `Recepción de mercadería ${numero}`, req.usuario.id]);
            }

            return recepcionId;
        });

        res.status(201).json(await db.one('SELECT * FROM recepciones WHERE id = $1', [recepcionId]));
    } catch (err) { next(err); }
});

router.post('/:id/anular', async (req, res, next) => {
    try {
        const recepcion = await db.one('SELECT * FROM recepciones WHERE id = $1', [req.params.id]);
        if (!recepcion) return res.status(404).json({ error: 'Recepción no encontrada.' });
        if (recepcion.estado === 'anulada') return res.status(400).json({ error: 'La recepción ya está anulada.' });

        const itemsLotes = await db.all(`
            SELECT ri.*, l.cantidad_actual, l.cantidad_inicial, p.nombre as producto_nombre
            FROM recepcion_items ri
            LEFT JOIN lotes l ON l.id = ri.lote_id
            JOIN productos p ON p.id = ri.producto_id
            WHERE ri.recepcion_id = $1
        `, [req.params.id]);

        for (const it of itemsLotes) {
            if (it.cantidad_actual !== null && Number(it.cantidad_actual) < Number(it.cantidad_inicial)) {
                return res.status(400).json({
                    error: `No se puede anular la recepción: el lote de "${it.producto_nombre}" ya fue utilizado o despachado en remitos (stock actual del lote: ${it.cantidad_actual}, inicial: ${it.cantidad_inicial}).`
                });
            }
        }

        await db.transaction(async (tx) => {
            const items = await tx.all('SELECT * FROM recepcion_items WHERE recepcion_id = $1', [req.params.id]);
            for (const item of items) {
                await tx.run('UPDATE productos SET stock_actual = stock_actual - $1 WHERE id = $2', [item.cantidad, item.producto_id]);
                await tx.run('UPDATE lotes SET cantidad_actual = 0 WHERE id = $1', [item.lote_id]);
                await tx.run(`
                    INSERT INTO movimientos_stock (producto_id, lote_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
                    VALUES ($1, $2, 'ajuste_negativo', $3, 'Anulación de recepción', 'recepcion', $4, $5)
                `, [item.producto_id, item.lote_id, item.cantidad, req.params.id, req.usuario.id]);
            }

            // Revertir saldo en cuenta corriente del proveedor si correspondía
            if (Number(recepcion.total) > 0) {
                await tx.run('UPDATE proveedores SET saldo_cuenta = saldo_cuenta - $1 WHERE id = $2', [recepcion.total, recepcion.proveedor_id]);
                await tx.run(`
                    INSERT INTO movimientos_cuenta (entidad_tipo, entidad_id, tipo, monto, medio_pago, referencia_tipo, referencia_id, observaciones, usuario_id)
                    VALUES ('proveedor', $1, 'ajuste', $2, 'ajuste', 'recepcion_anulada', $3, $4, $5)
                `, [recepcion.proveedor_id, recepcion.total, recepcion.id, `Anulación de recepción ${recepcion.numero}`, req.usuario.id]);
            }

            await tx.run("UPDATE recepciones SET estado = 'anulada' WHERE id = $1", [req.params.id]);
        });

        res.json(await db.one('SELECT * FROM recepciones WHERE id = $1', [req.params.id]));
    } catch (err) { next(err); }
});

module.exports = router;
