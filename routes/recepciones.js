const express = require('express');
const db = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { generarNumero } = require('../utils/numerador');

const router = express.Router();
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
            await tx.run("UPDATE recepciones SET estado = 'anulada' WHERE id = $1", [req.params.id]);
        });

        res.json(await db.one('SELECT * FROM recepciones WHERE id = $1', [req.params.id]));
    } catch (err) { next(err); }
});

module.exports = router;
