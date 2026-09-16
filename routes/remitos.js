const express = require('express');
const db = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { generarNumero } = require('../utils/numerador');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
    try {
        const { cliente_id, desde, hasta, estado } = req.query;
        let sql = `
            SELECT r.*, c.razon_social as cliente_nombre
            FROM remitos r
            JOIN clientes c ON c.id = r.cliente_id
            WHERE 1=1
        `;
        const params = [];
        if (cliente_id) { params.push(cliente_id); sql += ` AND r.cliente_id = $${params.length}`; }
        if (desde) { params.push(desde); sql += ` AND r.fecha >= $${params.length}`; }
        if (hasta) { params.push(hasta); sql += ` AND r.fecha <= $${params.length}`; }
        if (estado) { params.push(estado); sql += ` AND r.estado = $${params.length}`; }
        sql += ' ORDER BY r.fecha DESC, r.id DESC';

        res.json(await db.all(sql, params));
    } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
    try {
        const remito = await db.one(`
            SELECT r.*, c.razon_social as cliente_nombre, c.cuit as cliente_cuit,
                   c.condicion_iva as cliente_condicion_iva, c.direccion as cliente_direccion,
                   c.localidad as cliente_localidad, c.telefono as cliente_telefono, c.email as cliente_email
            FROM remitos r
            JOIN clientes c ON c.id = r.cliente_id WHERE r.id = $1
        `, [req.params.id]);
        if (!remito) return res.status(404).json({ error: 'Remito no encontrado.' });

        const items = await db.all(`
            SELECT ri.*, p.nombre as producto_nombre, p.codigo as producto_codigo, p.unidad_medida,
                   l.numero_lote, l.fecha_vencimiento
            FROM remito_items ri
            JOIN productos p ON p.id = ri.producto_id
            LEFT JOIN lotes l ON l.id = ri.lote_id
            WHERE ri.remito_id = $1
            ORDER BY ri.id ASC
        `, [req.params.id]);

        res.json({ ...remito, items });
    } catch (err) { next(err); }
});

/**
 * Crear remito. Descuenta stock usando lotes por FEFO (first-expired, first-out).
 */
router.post('/', async (req, res, next) => {
    try {
        const { cliente_id, fecha, direccion_entrega, transportista, observaciones, items, permitir_sin_stock } = req.body;

        if (!cliente_id) return res.status(400).json({ error: 'cliente_id es requerido.' });
        if (!items || !items.length) return res.status(400).json({ error: 'Debe incluir al menos un ítem.' });

        // Validar stock disponible a menos que se permita emitir sin stock previo
        for (const item of items) {
            const producto = await db.one('SELECT * FROM productos WHERE id = $1', [item.producto_id]);
            if (!producto) return res.status(400).json({ error: `Producto ${item.producto_id} no existe.` });
            if (!permitir_sin_stock && Number(producto.stock_actual) < Number(item.cantidad)) {
                return res.status(400).json({
                    error: `Stock insuficiente de "${producto.nombre}". Disponible: ${producto.stock_actual} ${producto.unidad_medida}. Podés tildar "Permitir emitir sin stock" si la mercadería ya ingresó físicamente.`
                });
            }
        }

        const remitoId = await db.transaction(async (tx) => {
            const numero = await generarNumero('remitos', 'REM', tx);
            const total = items.reduce((acc, it) => acc + (it.cantidad * it.precio_unitario), 0);

            const { row } = await tx.run(`
                INSERT INTO remitos (numero, cliente_id, fecha, direccion_entrega, transportista, observaciones, total, usuario_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
            `, [numero, cliente_id, fecha || new Date().toISOString().slice(0, 10), direccion_entrega || null, transportista || null, observaciones || null, total, req.usuario.id]);

            const remitoId = row.id;

            for (const item of items) {
                let cantidadRestante = Number(item.cantidad);

                // FEFO: tomar de los lotes que vencen antes primero
                const lotes = await tx.all(`
                    SELECT * FROM lotes WHERE producto_id = $1 AND cantidad_actual > 0
                    ORDER BY (fecha_vencimiento IS NULL), fecha_vencimiento ASC, fecha_ingreso ASC
                `, [item.producto_id]);

                let loteDeReferencia = null;
                for (const lote of lotes) {
                    if (cantidadRestante <= 0) break;
                    const tomar = Math.min(Number(lote.cantidad_actual), cantidadRestante);
                    await tx.run('UPDATE lotes SET cantidad_actual = cantidad_actual - $1 WHERE id = $2', [tomar, lote.id]);
                    cantidadRestante -= tomar;
                    if (!loteDeReferencia) loteDeReferencia = lote.id;
                }

                await tx.run(`
                    INSERT INTO remito_items (remito_id, producto_id, lote_id, cantidad, precio_unitario, subtotal)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [remitoId, item.producto_id, loteDeReferencia, item.cantidad, item.precio_unitario || 0, item.cantidad * (item.precio_unitario || 0)]);

                await tx.run('UPDATE productos SET stock_actual = stock_actual - $1 WHERE id = $2', [item.cantidad, item.producto_id]);

                await tx.run(`
                    INSERT INTO movimientos_stock (producto_id, lote_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
                    VALUES ($1, $2, 'egreso', $3, 'Remito a cliente', 'remito', $4, $5)
                `, [item.producto_id, loteDeReferencia, item.cantidad, remitoId, req.usuario.id]);
            }

            // Actualizar cuenta corriente del cliente si el remito tiene monto
            if (Number(total) > 0) {
                await tx.run('UPDATE clientes SET saldo_cuenta = saldo_cuenta + $1 WHERE id = $2', [total, cliente_id]);
                await tx.run(`
                    INSERT INTO movimientos_cuenta (entidad_tipo, entidad_id, tipo, monto, medio_pago, referencia_tipo, referencia_id, observaciones, usuario_id)
                    VALUES ('cliente', $1, 'cargo', $2, 'cuenta_corriente', 'remito', $3, $4, $5)
                `, [cliente_id, total, remitoId, `Emisión de remito ${numero}`, req.usuario.id]);
            }

            return remitoId;
        });

        res.status(201).json(await db.one('SELECT * FROM remitos WHERE id = $1', [remitoId]));
    } catch (err) { next(err); }
});

router.put('/:id/estado', async (req, res, next) => {
    try {
        const { estado } = req.body;
        const validos = ['pendiente', 'entregado', 'facturado', 'anulado'];
        if (!validos.includes(estado)) return res.status(400).json({ error: 'Estado inválido.' });

        const remito = await db.one('SELECT * FROM remitos WHERE id = $1', [req.params.id]);
        if (!remito) return res.status(404).json({ error: 'Remito no encontrado.' });

        if (estado === 'anulado' && remito.estado !== 'anulado') {
            await db.transaction(async (tx) => {
                const items = await tx.all('SELECT * FROM remito_items WHERE remito_id = $1', [req.params.id]);
                for (const item of items) {
                    await tx.run('UPDATE productos SET stock_actual = stock_actual + $1 WHERE id = $2', [item.cantidad, item.producto_id]);
                    if (item.lote_id) {
                        await tx.run('UPDATE lotes SET cantidad_actual = cantidad_actual + $1 WHERE id = $2', [item.cantidad, item.lote_id]);
                    }
                    await tx.run(`
                        INSERT INTO movimientos_stock (producto_id, lote_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
                        VALUES ($1, $2, 'ajuste_positivo', $3, 'Anulación de remito', 'remito', $4, $5)
                    `, [item.producto_id, item.lote_id, item.cantidad, req.params.id, req.usuario.id]);
                }

                // Revertir saldo en cuenta corriente del cliente si correspondía
                if (Number(remito.total) > 0) {
                    await tx.run('UPDATE clientes SET saldo_cuenta = saldo_cuenta - $1 WHERE id = $2', [remito.total, remito.cliente_id]);
                    await tx.run(`
                        INSERT INTO movimientos_cuenta (entidad_tipo, entidad_id, tipo, monto, medio_pago, referencia_tipo, referencia_id, observaciones, usuario_id)
                        VALUES ('cliente', $1, 'ajuste', $2, 'ajuste', 'remito_anulado', $3, $4, $5)
                    `, [remito.cliente_id, remito.total, remito.id, `Anulación de remito ${remito.numero}`, req.usuario.id]);
                }

                await tx.run('UPDATE remitos SET estado = $1 WHERE id = $2', [estado, req.params.id]);
            });
        } else {
            await db.run('UPDATE remitos SET estado = $1 WHERE id = $2', [estado, req.params.id]);
        }

        res.json(await db.one('SELECT * FROM remitos WHERE id = $1', [req.params.id]));
    } catch (err) { next(err); }
});

module.exports = router;
