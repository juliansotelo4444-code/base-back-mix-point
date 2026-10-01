const express = require('express');
const db = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { generarNumero } = require('../utils/numerador');
const AlertasService = require('../services/alertasService');

const router = express.Router();
router.use(requireAuth);

/**
 * Listar todas las recetas de mixes activas
 */
router.get('/recetas', async (req, res, next) => {
    try {
        const recetas = await db.all(`
            SELECT r.*, p.nombre as producto_nombre, p.codigo as producto_codigo, p.stock_actual as producto_stock
            FROM recetas r
            JOIN productos p ON p.id = r.producto_id
            WHERE r.activo = true
            ORDER BY r.nombre ASC
        `);

        for (const r of recetas) {
            r.ingredientes = await db.all(`
                SELECT ri.*, p.nombre as ingrediente_nombre, p.codigo as ingrediente_codigo,
                       p.unidad_medida, p.stock_actual as ingrediente_stock, p.precio_compra as ingrediente_costo
                FROM receta_ingredientes ri
                JOIN productos p ON p.id = ri.producto_ingrediente_id
                WHERE ri.receta_id = $1
                ORDER BY ri.porcentaje DESC
            `, [r.id]);
        }

        res.json(recetas);
    } catch (err) { next(err); }
});

/**
 * Crear o actualizar una receta de Mix
 */
router.post('/recetas', async (req, res, next) => {
    try {
        const { id, producto_id, nombre, descripcion, rendimiento_kg, ingredientes } = req.body;
        if (!producto_id) return res.status(400).json({ error: 'producto_id (el producto resultante) es requerido.' });
        if (!nombre) return res.status(400).json({ error: 'nombre de la receta es requerido.' });
        if (!ingredientes || !ingredientes.length) return res.status(400).json({ error: 'Debe incluir al menos un ingrediente.' });

        const recetaId = await db.transaction(async (tx) => {
            let rId = id;
            if (rId) {
                await tx.run(`
                    UPDATE recetas SET
                        producto_id = $1, nombre = $2, descripcion = $3, rendimiento_kg = $4
                    WHERE id = $5
                `, [producto_id, nombre, descripcion || null, Number(rendimiento_kg) || 100, rId]);
                await tx.run('DELETE FROM receta_ingredientes WHERE receta_id = $1', [rId]);
            } else {
                const { row } = await tx.run(`
                    INSERT INTO recetas (producto_id, nombre, descripcion, rendimiento_kg)
                    VALUES ($1, $2, $3, $4) RETURNING id
                `, [producto_id, nombre, descripcion || null, Number(rendimiento_kg) || 100]);
                rId = row.id;
            }

            for (const ing of ingredientes) {
                if (!ing.producto_ingrediente_id) continue;
                await tx.run(`
                    INSERT INTO receta_ingredientes (receta_id, producto_ingrediente_id, porcentaje, cantidad_por_batch)
                    VALUES ($1, $2, $3, $4)
                `, [rId, ing.producto_ingrediente_id, Number(ing.porcentaje) || 0, Number(ing.cantidad_por_batch) || 0]);
            }

            return rId;
        });

        res.status(201).json({ id: recetaId, ok: true });
    } catch (err) { next(err); }
});

/**
 * Desactivar una receta
 */
router.delete('/recetas/:id', async (req, res, next) => {
    try {
        await db.run('UPDATE recetas SET activo = false WHERE id = $1', [req.params.id]);
        res.json({ ok: true });
    } catch (err) { next(err); }
});

/**
 * Simular elaboración: calcula insumos requeridos y verifica si hay stock suficiente
 */
router.post('/simular', async (req, res, next) => {
    try {
        const { receta_id, cantidad_kg } = req.body;
        const cant = Number(cantidad_kg);
        if (!receta_id || !cant || cant <= 0) {
            return res.status(400).json({ error: 'receta_id y cantidad_kg mayor a 0 son requeridos.' });
        }

        const receta = await db.one('SELECT * FROM recetas WHERE id = $1 AND activo = true', [receta_id]);
        if (!receta) return res.status(404).json({ error: 'Receta no encontrada.' });

        const ingredientes = await db.all(`
            SELECT ri.*, p.nombre, p.stock_actual, p.precio_compra, p.unidad_medida
            FROM receta_ingredientes ri
            JOIN productos p ON p.id = ri.producto_ingrediente_id
            WHERE ri.receta_id = $1
        `, [receta_id]);

        let costoEstimadoTotal = 0;
        let factible = true;

        const detalleInsumos = ingredientes.map(ing => {
            const kgNecesarios = Math.round((cant * (Number(ing.porcentaje) / 100)) * 1000) / 1000;
            const stockActual = Number(ing.stock_actual) || 0;
            const suficiente = stockActual >= kgNecesarios;
            if (!suficiente) factible = false;

            const costoUnitario = Number(ing.precio_compra) || 0;
            const subtotalCosto = kgNecesarios * costoUnitario;
            costoEstimadoTotal += subtotalCosto;

            return {
                producto_id: ing.producto_ingrediente_id,
                nombre: ing.nombre,
                porcentaje: Number(ing.porcentaje),
                kg_necesarios: kgNecesarios,
                stock_actual: stockActual,
                suficiente,
                costo_unitario: costoUnitario,
                subtotal_costo: subtotalCosto
            };
        });

        const costoPorKgEstimado = cant > 0 ? costoEstimadoTotal / cant : 0;

        res.json({
            receta_nombre: receta.nombre,
            cantidad_kg: cant,
            factible,
            costo_estimado_total: Math.round(costoEstimadoTotal),
            costo_estimado_kg: Math.round(costoPorKgEstimado),
            insumos: detalleInsumos
        });
    } catch (err) { next(err); }
});

/**
 * Ejecutar una orden de producción / elaboración de Mix
 */
router.post('/elaborar', async (req, res, next) => {
    try {
        const { receta_id, cantidad_kg, fecha_vencimiento, observaciones } = req.body;
        const cant = Number(cantidad_kg);
        if (!receta_id || !cant || cant <= 0) {
            return res.status(400).json({ error: 'receta_id y cantidad_kg mayor a 0 son requeridos.' });
        }

        const receta = await db.one('SELECT * FROM recetas WHERE id = $1 AND activo = true', [receta_id]);
        if (!receta) return res.status(404).json({ error: 'Receta no encontrada.' });

        const ingredientes = await db.all(`
            SELECT ri.*, p.nombre, p.stock_actual, p.precio_compra
            FROM receta_ingredientes ri
            JOIN productos p ON p.id = ri.producto_ingrediente_id
            WHERE ri.receta_id = $1
        `, [receta_id]);

        if (!ingredientes.length) {
            return res.status(400).json({ error: 'La receta no tiene ingredientes configurados.' });
        }

        // 1. Validar que haya stock suficiente de todos los ingredientes
        for (const ing of ingredientes) {
            const kgNecesarios = (cant * (Number(ing.porcentaje) / 100));
            if (Number(ing.stock_actual) < kgNecesarios) {
                return res.status(400).json({
                    error: `Stock insuficiente de "${ing.nombre}". Necesarios: ${kgNecesarios.toFixed(2)} kg, Disponible: ${ing.stock_actual} kg.`
                });
            }
        }

        // 2. Ejecutar transacción de producción
        const resultado = await db.transaction(async (tx) => {
            const numero = await generarNumero('producciones', 'PRD', tx);
            let costoTotalProduccion = 0;
            const insumosConsumidos = [];
            let fechaVencimientoSugerida = null;

            for (const ing of ingredientes) {
                let cantidadRestante = (cant * (Number(ing.porcentaje) / 100));

                // Consumo FEFO de lotes
                const lotes = await tx.all(`
                    SELECT * FROM lotes WHERE producto_id = $1 AND cantidad_actual > 0
                    ORDER BY (fecha_vencimiento IS NULL), fecha_vencimiento ASC, fecha_ingreso ASC
                `, [ing.producto_ingrediente_id]);

                for (const lote of lotes) {
                    if (cantidadRestante <= 0) break;
                    const tomar = Math.min(Number(lote.cantidad_actual), cantidadRestante);
                    await tx.run('UPDATE lotes SET cantidad_actual = cantidad_actual - $1 WHERE id = $2', [tomar, lote.id]);
                    cantidadRestante -= tomar;

                    const costoLote = Number(lote.costo_unitario) || Number(ing.precio_compra) || 0;
                    costoTotalProduccion += (tomar * costoLote);

                    if (lote.fecha_vencimiento) {
                        if (!fechaVencimientoSugerida || new Date(lote.fecha_vencimiento) < new Date(fechaVencimientoSugerida)) {
                            fechaVencimientoSugerida = lote.fecha_vencimiento;
                        }
                    }

                    insumosConsumidos.push({
                        producto_id: ing.producto_ingrediente_id,
                        lote_id: lote.id,
                        cantidad_usada: tomar,
                        costo_unitario: costoLote
                    });
                }

                const totalKgIngrediente = (cant * (Number(ing.porcentaje) / 100));
                await tx.run('UPDATE productos SET stock_actual = stock_actual - $1 WHERE id = $2', [totalKgIngrediente, ing.producto_ingrediente_id]);
                await tx.run(`
                    INSERT INTO movimientos_stock (producto_id, tipo, cantidad, motivo, referencia_tipo, usuario_id)
                    VALUES ($1, 'egreso', $2, $3, 'produccion', $4)
                `, [ing.producto_ingrediente_id, totalKgIngrediente, `Consumo p/ elaboración ${receta.nombre} (${numero})`, req.usuario.id]);
            }

            const costoUnitarioFinal = Math.round((costoTotalProduccion / cant) * 100) / 100;
            const vtoDate = fecha_vencimiento || fechaVencimientoSugerida || new Date(Date.now() + 365*24*60*60*1000).toISOString().slice(0, 10);
            const loteNum = `MIX-${receta.producto_id}-${Date.now().toString().slice(-5)}`;

            // Crear nuevo lote para el producto terminado
            const { row: nuevoLote } = await tx.run(`
                INSERT INTO lotes (
                    producto_id, numero_lote, fecha_ingreso, fecha_vencimiento,
                    cantidad_inicial, cantidad_actual, costo_unitario
                ) VALUES ($1, $2, CURRENT_DATE, $3, $4, $4, $5) RETURNING id
            `, [receta.producto_id, loteNum, vtoDate, cant, costoUnitarioFinal]);

            // Sumar stock al producto resultante y actualizar su precio de costo
            await tx.run('UPDATE productos SET stock_actual = stock_actual + $1, precio_compra = $2 WHERE id = $3',
                [cant, costoUnitarioFinal, receta.producto_id]);

            // Movimiento kardex de ingreso
            await tx.run(`
                INSERT INTO movimientos_stock (producto_id, lote_id, tipo, cantidad, motivo, referencia_tipo, usuario_id)
                VALUES ($1, $2, 'ingreso', $3, $4, 'produccion', $5)
            `, [receta.producto_id, nuevoLote.id, cant, `Elaboración de Mix ${receta.nombre} (${numero})`, req.usuario.id]);

            // Registrar en tabla producciones
            const { row: prodRow } = await tx.run(`
                INSERT INTO producciones (
                    numero, receta_id, producto_id, cantidad_producida, lote_id,
                    fecha, costo_unitario, costo_total, observaciones, usuario_id
                ) VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, $6, $7, $8, $9) RETURNING id
            `, [numero, receta.id, receta.producto_id, cant, nuevoLote.id, costoUnitarioFinal, costoTotalProduccion, observaciones || null, req.usuario.id]);

            // Registrar detalle de insumos
            for (const ins of insumosConsumidos) {
                await tx.run(`
                    INSERT INTO produccion_insumos (produccion_id, producto_id, lote_id, cantidad_usada, costo_unitario)
                    VALUES ($1, $2, $3, $4, $5)
                `, [prodRow.id, ins.producto_id, ins.lote_id, ins.cantidad_usada, ins.costo_unitario]);
            }

            return {
                produccion_id: prodRow.id,
                numero,
                lote_id: nuevoLote.id,
                numero_lote: loteNum,
                cantidad_producida: cant,
                costo_unitario: costoUnitarioFinal,
                costo_total: Math.round(costoTotalProduccion)
            };
        });

        // Verificar alertas de stock para los insumos utilizados
        if (receta.ingredientes && receta.ingredientes.length > 0) {
            AlertasService.verificarMultiplesProductos(receta.ingredientes.map(i => i.producto_ingrediente_id)).catch(() => {});
        }

        res.status(201).json(resultado);
    } catch (err) { next(err); }
});

/**
 * Historial de producciones realizadas
 */
router.get('/historial', async (req, res, next) => {
    try {
        const producciones = await db.all(`
            SELECT pr.*, p.nombre as producto_nombre, p.unidad_medida,
                   l.numero_lote, l.fecha_vencimiento,
                   u.nombre as usuario_nombre,
                   r.nombre as receta_nombre
            FROM producciones pr
            JOIN productos p ON p.id = pr.producto_id
            LEFT JOIN lotes l ON l.id = pr.lote_id
            LEFT JOIN usuarios u ON u.id = pr.usuario_id
            LEFT JOIN recetas r ON r.id = pr.receta_id
            ORDER BY pr.fecha DESC, pr.id DESC LIMIT 50
        `);

        for (const p of producciones) {
            p.insumos = await db.all(`
                SELECT pi.*, pr.nombre as insumo_nombre, l.numero_lote as insumo_lote
                FROM produccion_insumos pi
                JOIN productos pr ON pr.id = pi.producto_id
                LEFT JOIN lotes l ON l.id = pi.lote_id
                WHERE pi.produccion_id = $1
            `, [p.id]);
        }

        res.json(producciones);
    } catch (err) { next(err); }
});

module.exports = router;
