const express = require('express');
const db = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { generarNumero } = require('../utils/numerador');
const AlertasService = require('../services/alertasService');

// Retorna la fecha de hoy 'YYYY-MM-DD' en la zona horaria de Argentina (America/Argentina/Buenos_Aires)
function getFechaHoyBuenosAires() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Argentina/Buenos_Aires',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());
}

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
    try {
        const { cliente_id, desde, hasta, estado } = req.query;
        let sql = `
            SELECT r.*, c.razon_social as cliente_nombre, c.telefono as cliente_telefono,
                   EXISTS (
                       SELECT 1 FROM conciliaciones_bancarias cb 
                       WHERE cb.remito_id = r.id AND cb.estado = 'conciliado'
                   ) as pago_validado
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
                   c.localidad as cliente_localidad, c.telefono as cliente_telefono, c.email as cliente_email,
                   EXISTS (
                       SELECT 1 FROM conciliaciones_bancarias cb 
                       WHERE cb.remito_id = r.id AND cb.estado = 'conciliado'
                   ) as pago_validado
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
 * Crear remito. Si se crea como 'entregado', descuenta stock por FEFO y carga la cuenta corriente.
 * Si se crea en estados previos (pendiente, en_preparacion, etc.), guarda la orden sin descontar aún.
 */
router.post('/', async (req, res, next) => {
    try {
        const {
            cliente_id, fecha, direccion_entrega, transportista, observaciones,
            items, permitir_sin_stock, estado = 'pendiente', descuento_porcentaje = 0
        } = req.body;

        if (!cliente_id) return res.status(400).json({ error: 'cliente_id es requerido.' });
        if (!items || !items.length) return res.status(400).json({ error: 'Debe incluir al menos un ítem.' });

        const estadosValidos = ['pendiente', 'en_preparacion', 'esperando_pago', 'en_camino', 'entregado', 'facturado', 'cancelado', 'anulado'];
        const estadoFinal = estadosValidos.includes(estado) ? estado : 'pendiente';
        const descPorc = Math.max(0, Math.min(100, Number(descuento_porcentaje) || 0));

        // Si se emite directamente como entregado, validar stock a menos que se permita sin stock
        if (estadoFinal === 'entregado') {
            for (const item of items) {
                const producto = await db.one('SELECT * FROM productos WHERE id = $1', [item.producto_id]);
                if (!producto) return res.status(400).json({ error: `Producto ${item.producto_id} no existe.` });
                if (!permitir_sin_stock && Number(producto.stock_actual) < Number(item.cantidad)) {
                    return res.status(400).json({
                        error: `Stock insuficiente de "${producto.nombre}". Disponible: ${producto.stock_actual} ${producto.unidad_medida}.`
                    });
                }
            }
        }

        const subtotalBruto = items.reduce((acc, it) => acc + (Number(it.cantidad || 0) * Number(it.precio_unitario || 0)), 0);
        const total = Math.round((subtotalBruto - (subtotalBruto * (descPorc / 100))) * 100) / 100;
        const debeDescontar = (estadoFinal === 'entregado');

        const remitoId = await db.transaction(async (tx) => {
            const numero = await generarNumero('remitos', 'REM', tx);

            const fechaEmision = (fecha && String(fecha).trim()) ? String(fecha).slice(0, 10) : getFechaHoyBuenosAires();

            const { row } = await tx.run(`
                INSERT INTO remitos (
                    numero, cliente_id, fecha, direccion_entrega, transportista,
                    observaciones, total, estado, stock_descontado, descuento_porcentaje, usuario_id
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id
            `, [
                numero, cliente_id, fechaEmision,
                direccion_entrega || null, transportista || null, observaciones || null,
                total, estadoFinal, debeDescontar, descPorc, req.usuario.id
            ]);

            const rId = row.id;

            for (const item of items) {
                const cant = Number(item.cantidad) || 0;
                const precio = Number(item.precio_unitario) || 0;
                const subtotal = Math.round(cant * precio * 100) / 100;
                let loteRef = null;

                if (debeDescontar) {
                    let cantidadRestante = cant;
                    const lotes = await tx.all(`
                        SELECT * FROM lotes WHERE producto_id = $1 AND cantidad_actual > 0
                        ORDER BY (fecha_vencimiento IS NULL), fecha_vencimiento ASC, fecha_ingreso ASC
                    `, [item.producto_id]);

                    for (const lote of lotes) {
                        if (cantidadRestante <= 0) break;
                        const tomar = Math.min(Number(lote.cantidad_actual), cantidadRestante);
                        await tx.run('UPDATE lotes SET cantidad_actual = cantidad_actual - $1 WHERE id = $2', [tomar, lote.id]);
                        cantidadRestante -= tomar;
                        if (!loteRef) loteRef = lote.id;
                    }

                    await tx.run('UPDATE productos SET stock_actual = stock_actual - $1 WHERE id = $2', [cant, item.producto_id]);
                    await tx.run(`
                        INSERT INTO movimientos_stock (producto_id, lote_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
                        VALUES ($1, $2, 'egreso', $3, 'Entrega remito', 'remito', $4, $5)
                    `, [item.producto_id, loteRef, cant, rId, req.usuario.id]);
                }

                await tx.run(`
                    INSERT INTO remito_items (remito_id, producto_id, lote_id, cantidad, precio_unitario, subtotal)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [rId, item.producto_id, loteRef, cant, precio, subtotal]);
            }

            // Si se entregó y tiene importe, actualizar saldo en cuenta corriente
            if (debeDescontar && total > 0) {
                await tx.run('UPDATE clientes SET saldo_cuenta = saldo_cuenta + $1 WHERE id = $2', [total, cliente_id]);
                await tx.run(`
                    INSERT INTO movimientos_cuenta (entidad_tipo, entidad_id, tipo, monto, medio_pago, referencia_tipo, referencia_id, observaciones, usuario_id)
                    VALUES ('cliente', $1, 'cargo', $2, 'cuenta_corriente', 'remito', $3, $4, $5)
                `, [cliente_id, total, rId, `Emisión y entrega de remito ${numero}`, req.usuario.id]);
            }

            return rId;
        });

        if (debeDescontar && items && items.length > 0) {
            AlertasService.verificarMultiplesProductos(items.map(it => it.producto_id)).catch(() => {});
        }

        res.status(201).json(await db.one('SELECT * FROM remitos WHERE id = $1', [remitoId]));
    } catch (err) { next(err); }
});

/**
 * Actualizar estado del remito (Ciclo de 7 estados).
 * Al transicionar a 'entregado', se descuenta el stock por FEFO y se impacta en cuenta corriente.
 * Al transicionar a 'cancelado' o 'anulado', si ya estaba entregado, se revierte el stock y el saldo.
 */
router.put('/:id/estado', async (req, res, next) => {
    try {
        const { estado } = req.body;
        const validos = ['pendiente', 'en_preparacion', 'esperando_pago', 'en_camino', 'entregado', 'facturado', 'cancelado', 'anulado'];
        if (!validos.includes(estado)) return res.status(400).json({ error: 'Estado inválido.' });

        const remito = await db.one('SELECT * FROM remitos WHERE id = $1', [req.params.id]);
        if (!remito) return res.status(404).json({ error: 'Remito no encontrado.' });

        const estadoPrevio = remito.estado;
        const yaDescontado = Boolean(remito.stock_descontado);
        const nuevoEsEntregado = (estado === 'entregado' || estado === 'facturado');
        const nuevoEsCancelado = (estado === 'cancelado' || estado === 'anulado');

        await db.transaction(async (tx) => {
            const items = await tx.all('SELECT * FROM remito_items WHERE remito_id = $1', [remito.id]);

            // CASO 1: Transición hacia 'entregado' (y no había descontado aún)
            if (nuevoEsEntregado && !yaDescontado) {
                for (const item of items) {
                    let cantidadRestante = Number(item.cantidad);
                    let loteRef = item.lote_id || null;

                    // FEFO
                    const lotes = await tx.all(`
                        SELECT * FROM lotes WHERE producto_id = $1 AND cantidad_actual > 0
                        ORDER BY (fecha_vencimiento IS NULL), fecha_vencimiento ASC, fecha_ingreso ASC
                    `, [item.producto_id]);

                    for (const lote of lotes) {
                        if (cantidadRestante <= 0) break;
                        const tomar = Math.min(Number(lote.cantidad_actual), cantidadRestante);
                        await tx.run('UPDATE lotes SET cantidad_actual = cantidad_actual - $1 WHERE id = $2', [tomar, lote.id]);
                        cantidadRestante -= tomar;
                        if (!loteRef) loteRef = lote.id;
                    }

                    await tx.run('UPDATE productos SET stock_actual = stock_actual - $1 WHERE id = $2', [item.cantidad, item.producto_id]);
                    await tx.run(`
                        UPDATE remito_items SET lote_id = COALESCE(lote_id, $1) WHERE id = $2
                    `, [loteRef, item.id]);

                    await tx.run(`
                        INSERT INTO movimientos_stock (producto_id, lote_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
                        VALUES ($1, $2, 'egreso', $3, 'Entrega confirmada remito', 'remito', $4, $5)
                    `, [item.producto_id, loteRef, item.cantidad, remito.id, req.usuario.id]);
                }

                // Debitar cuenta corriente
                if (Number(remito.total) > 0) {
                    await tx.run('UPDATE clientes SET saldo_cuenta = saldo_cuenta + $1 WHERE id = $2', [remito.total, remito.cliente_id]);
                    await tx.run(`
                        INSERT INTO movimientos_cuenta (entidad_tipo, entidad_id, tipo, monto, medio_pago, referencia_tipo, referencia_id, observaciones, usuario_id)
                        VALUES ('cliente', $1, 'cargo', $2, 'cuenta_corriente', 'remito', $3, $4, $5)
                    `, [remito.cliente_id, remito.total, remito.id, `Entrega de remito ${remito.numero}`, req.usuario.id]);
                }

                await tx.run('UPDATE remitos SET estado = $1, stock_descontado = true WHERE id = $2', [estado, remito.id]);
            }
            // CASO 2: Cancelación de un remito que ya había descontado stock
            else if (nuevoEsCancelado && yaDescontado) {
                for (const item of items) {
                    await tx.run('UPDATE productos SET stock_actual = stock_actual + $1 WHERE id = $2', [item.cantidad, item.producto_id]);
                    if (item.lote_id) {
                        await tx.run('UPDATE lotes SET cantidad_actual = cantidad_actual + $1 WHERE id = $2', [item.cantidad, item.lote_id]);
                    }
                    await tx.run(`
                        INSERT INTO movimientos_stock (producto_id, lote_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
                        VALUES ($1, $2, 'ajuste_positivo', $3, 'Cancelación de remito entregado', 'remito', $4, $5)
                    `, [item.producto_id, item.lote_id, item.cantidad, remito.id, req.usuario.id]);
                }

                // Revertir deuda
                if (Number(remito.total) > 0) {
                    await tx.run('UPDATE clientes SET saldo_cuenta = saldo_cuenta - $1 WHERE id = $2', [remito.total, remito.cliente_id]);
                    await tx.run(`
                        INSERT INTO movimientos_cuenta (entidad_tipo, entidad_id, tipo, monto, medio_pago, referencia_tipo, referencia_id, observaciones, usuario_id)
                        VALUES ('cliente', $1, 'ajuste', $2, 'ajuste', 'remito_cancelado', $3, $4, $5)
                    `, [remito.cliente_id, remito.total, remito.id, `Cancelación de remito ${remito.numero}`, req.usuario.id]);
                }

                await tx.run('UPDATE remitos SET estado = $1, stock_descontado = false WHERE id = $2', [estado, remito.id]);
            }
            // CASO 3: Transición intermedia (ej. pendiente -> en_preparacion -> en_camino)
            else {
                await tx.run('UPDATE remitos SET estado = $1 WHERE id = $2', [estado, remito.id]);
            }
        });

        // Alerta de stock si se entregó
        if (nuevoEsEntregado && !yaDescontado) {
            const items = await db.all('SELECT producto_id FROM remito_items WHERE remito_id = $1', [remito.id]);
            AlertasService.verificarMultiplesProductos(items.map(it => it.producto_id)).catch(() => {});
        }

        res.json(await db.one('SELECT * FROM remitos WHERE id = $1', [req.params.id]));
    } catch (err) { next(err); }
});

/**
 * Genera la Hoja de Ruta de Reparto y la Planilla de Picking consolidada
 * para un conjunto de IDs de remitos.
 */
router.post('/hoja-de-ruta', async (req, res, next) => {
    try {
        const { remito_ids } = req.body;
        if (!remito_ids || !Array.isArray(remito_ids) || !remito_ids.length) {
            return res.status(400).json({ error: 'Debe proporcionar al menos un ID de remito.' });
        }

        const ids = remito_ids.map(Number).filter(Boolean);
        const remitos = await db.all(`
            SELECT r.*, c.razon_social as cliente_nombre, c.telefono as cliente_telefono,
                   c.direccion as cliente_direccion_base, c.localidad as cliente_localidad,
                   c.cuit as cliente_cuit, c.saldo_cuenta as cliente_saldo_cuenta
            FROM remitos r
            JOIN clientes c ON c.id = r.cliente_id
            WHERE r.id = ANY($1::int[]) AND r.estado != 'anulado'
            ORDER BY c.localidad ASC, r.fecha ASC, r.id ASC
        `, [ids]);

        for (const r of remitos) {
            r.items = await db.all(`
                SELECT ri.*, p.nombre as producto_nombre, p.codigo as producto_codigo, p.unidad_medida
                FROM remito_items ri
                JOIN productos p ON p.id = ri.producto_id
                WHERE ri.remito_id = $1
            `, [r.id]);
        }

        const picking = await db.all(`
            SELECT p.id as producto_id, p.codigo, p.nombre as producto_nombre, p.unidad_medida,
                   SUM(ri.cantidad) as total_cantidad,
                   COUNT(DISTINCT r.id) as cantidad_pedidos
            FROM remito_items ri
            JOIN remitos r ON r.id = ri.remito_id
            JOIN productos p ON p.id = ri.producto_id
            WHERE r.id = ANY($1::int[]) AND r.estado != 'anulado'
            GROUP BY p.id, p.codigo, p.nombre, p.unidad_medida
            ORDER BY p.nombre ASC
        `, [ids]);

        const totalKilos = picking.reduce((acc, it) => acc + (it.unidad_medida === 'kg' ? Number(it.total_cantidad) : 0), 0);
        const totalImporte = remitos.reduce((acc, r) => acc + Number(r.total || 0), 0);

        res.json({
            remitos,
            picking,
            totales: {
                cantidad_remitos: remitos.length,
                total_kilos: Math.round(totalKilos * 100) / 100,
                total_importe: Math.round(totalImporte * 100) / 100
            }
        });
    } catch (err) { next(err); }
});

module.exports = router;
