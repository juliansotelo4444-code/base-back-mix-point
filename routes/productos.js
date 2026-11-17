const express = require('express');
const db = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const AlertasService = require('../services/alertasService');
const AuditService = require('../services/auditService');

const router = express.Router();

// Endpoint público para el E-commerce / Tienda Web (sin autenticación requerida)
router.get('/public', async (req, res, next) => {
    try {
        const sql = `
            SELECT 
                p.id,
                p.codigo,
                p.nombre,
                p.descripcion,
                p.imagen,
                p.categoria_id,
                COALESCE(c.nombre, 'Varios') as categoria,
                p.unidad_medida,
                p.precio_venta,
                p.precio_5kg,
                p.precio_10kg,
                p.precio_25kg,
                p.precio_30kg,
                p.precio_oferta,
                p.destacado_carrusel,
                p.badge_carrusel,
                p.orden_carrusel,
                p.stock_actual,
                p.activo
            FROM productos p
            LEFT JOIN categorias_producto c ON c.id = p.categoria_id
            WHERE p.activo = true
            ORDER BY c.nombre ASC, p.nombre ASC
        `;
        const items = await db.all(sql);
        res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
        res.json(items);
    } catch (err) { next(err); }
});

router.use(requireAuth);

router.get('/buscar-imagenes', async (req, res, next) => {
    try {
        const q = (req.query.q || '').trim();
        if (!q) return res.json({ ok: true, resultados: [] });

        const resultados = [];
        const seenUrls = new Set();

        // 1. Coincidencias en base de productos existentes
        const sql = `
            SELECT id, nombre, imagen 
            FROM productos 
            WHERE imagen IS NOT NULL AND imagen != '' AND imagen NOT LIKE '%generico%'
              AND (nombre ILIKE $1 OR descripcion ILIKE $1)
            LIMIT 8
        `;
        const locales = await db.all(sql, [`%${q}%`]);
        for (const loc of locales) {
            if (loc.imagen && !seenUrls.has(loc.imagen)) {
                seenUrls.add(loc.imagen);
                resultados.push({
                    titulo: loc.nombre,
                    url: loc.imagen,
                    fuente: 'Catálogo de la base'
                });
            }
        }

        res.json({ ok: true, resultados });
    } catch (err) {
        next(err);
    }
});

router.get('/categorias', async (req, res, next) => {
    try {
        res.json(await db.all('SELECT * FROM categorias_producto ORDER BY nombre'));
    } catch (err) { next(err); }
});

router.post('/categorias', async (req, res, next) => {
    try {
        const { nombre } = req.body;
        if (!nombre) return res.status(400).json({ error: 'nombre es requerido.' });
        const { row } = await db.run(
            'INSERT INTO categorias_producto (nombre) VALUES ($1) ON CONFLICT (nombre) DO UPDATE SET nombre = EXCLUDED.nombre RETURNING id',
            [nombre]
        );
        res.status(201).json({ id: row.id, nombre });
    } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
    try {
        const { q, activo, bajo_stock, categoria_id } = req.query;
        let sql = `
            SELECT p.*, c.nombre as categoria_nombre
            FROM productos p
            LEFT JOIN categorias_producto c ON c.id = p.categoria_id
            WHERE 1=1
        `;
        const params = [];

        if (q) {
            params.push(`%${q}%`, `%${q}%`);
            sql += ` AND (p.nombre ILIKE $${params.length - 1} OR p.codigo ILIKE $${params.length})`;
        }
        if (categoria_id) {
            params.push(Number(categoria_id));
            sql += ` AND p.categoria_id = $${params.length}`;
        }
        if (activo !== undefined) {
            params.push(activo === '1');
            sql += ` AND p.activo = $${params.length}`;
        }
        if (bajo_stock === '1') {
            sql += ' AND p.stock_actual <= p.stock_minimo';
        }
        sql += ' ORDER BY p.nombre ASC';

        res.json(await db.all(sql, params));
    } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
    try {
        const producto = await db.one('SELECT * FROM productos WHERE id = $1', [req.params.id]);
        if (!producto) return res.status(404).json({ error: 'Producto no encontrado.' });

        const lotes = await db.all(`
            SELECT * FROM lotes WHERE producto_id = $1 AND cantidad_actual > 0 ORDER BY fecha_vencimiento ASC
        `, [req.params.id]);

        res.json({ ...producto, lotes });
    } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
    try {
        const {
            codigo, nombre, descripcion, imagen, categoria_id, unidad_medida,
            precio_compra, precio_venta, precio_5kg, precio_10kg, precio_25kg, precio_30kg, stock_minimo
        } = req.body;
        if (!nombre) return res.status(400).json({ error: 'nombre es requerido.' });

        const { row } = await db.run(`
            INSERT INTO productos (
                codigo, nombre, descripcion, imagen, categoria_id, unidad_medida,
                precio_compra, precio_venta, precio_5kg, precio_10kg, precio_25kg, precio_30kg,
                stock_minimo, stock_actual, modificado_en_app, updated_at, origen_datos
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, true, NOW(), 'app')
            RETURNING id
        `, [
            codigo || null, nombre, descripcion || null, imagen || null, categoria_id || null, unidad_medida || 'kg',
            precio_compra || 0, precio_venta || 0, precio_5kg || 0, precio_10kg || 0, precio_25kg || 0, precio_30kg || 0, stock_minimo || 0
        ]);

        const nuevoProd = await db.one('SELECT * FROM productos WHERE id = $1', [row.id]);
        AuditService.registrar({
            usuario_id: req.usuario?.id,
            accion: 'CREO_PRODUCTO',
            entidad: 'productos',
            entidad_id: row.id,
            detalles: { nombre: nuevoProd.nombre, codigo: nuevoProd.codigo, precio_venta: nuevoProd.precio_venta }
        }).catch(() => {});

        res.status(201).json(nuevoProd);
    } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
    try {
        const existente = await db.one('SELECT * FROM productos WHERE id = $1', [req.params.id]);
        if (!existente) return res.status(404).json({ error: 'Producto no encontrado.' });

        const p = { ...existente, ...req.body };
        const { row: actualizado } = await db.run(`
            UPDATE productos SET
                codigo=$1, nombre=$2, descripcion=$3, imagen=$4, categoria_id=$5, unidad_medida=$6,
                precio_compra=$7, precio_venta=$8, precio_5kg=$9, precio_10kg=$10, precio_25kg=$11, precio_30kg=$12,
                stock_minimo=$13, activo=$14,
                destacado_carrusel=$15, badge_carrusel=$16, orden_carrusel=$17, precio_oferta=$18,
                modificado_en_app=true, updated_at=NOW()
            WHERE id = $19
            RETURNING *
        `, [
            p.codigo, p.nombre, p.descripcion, p.imagen, p.categoria_id, p.unidad_medida,
            p.precio_compra, p.precio_venta, p.precio_5kg, p.precio_10kg, p.precio_25kg, p.precio_30kg,
            p.stock_minimo, p.activo,
            Boolean(p.destacado_carrusel), p.badge_carrusel || '🔥 OFERTA', Number(p.orden_carrusel) || 0, p.precio_oferta ? Number(p.precio_oferta) : null,
            req.params.id
        ]);

        AuditService.registrar({
            usuario_id: req.usuario?.id,
            accion: 'EDITO_PRODUCTO',
            entidad: 'productos',
            entidad_id: req.params.id,
            detalles: {
                antes: { nombre: existente.nombre, precio_venta: existente.precio_venta, precio_5kg: existente.precio_5kg },
                despues: { nombre: p.nombre, precio_venta: p.precio_venta, precio_5kg: p.precio_5kg }
            }
        }).catch(() => {});

        res.json(actualizado || await db.one('SELECT * FROM productos WHERE id = $1', [req.params.id]));
    } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
    try {
        const existente = await db.one('SELECT * FROM productos WHERE id = $1', [req.params.id]);
        if (!existente) return res.status(404).json({ error: 'Producto no encontrado.' });
        
        await db.run(
            `UPDATE productos 
             SET activo = false, 
                 stock_actual = 0, 
                 destacado_carrusel = false, 
                 modificado_en_app = true, 
                 updated_at = NOW() 
             WHERE id = $1`,
            [req.params.id]
        );

        AuditService.registrar({
            usuario_id: req.usuario?.id,
            accion: 'ELIMINO_PRODUCTO',
            entidad: 'productos',
            entidad_id: req.params.id,
            detalles: { nombre: existente.nombre, codigo: existente.codigo }
        }).catch(() => {});

        res.json({ ok: true, mensaje: `Producto "${existente.nombre}" eliminado correctamente.` });
    } catch (err) { next(err); }
});

// Ajuste manual de stock (mermas, conteos físicos, etc.) con sincronización de lotes
router.post('/:id/ajuste-stock', async (req, res, next) => {
    try {
        const { cantidad, motivo, lote_id, fecha_vencimiento } = req.body;
        const producto = await db.one('SELECT * FROM productos WHERE id = $1', [req.params.id]);
        if (!producto) return res.status(404).json({ error: 'Producto no encontrado.' });
        const numCant = Number(cantidad);
        if (cantidad === undefined || numCant === 0) return res.status(400).json({ error: 'cantidad es requerida y debe ser distinta de 0.' });

        const tipo = numCant > 0 ? 'ajuste_positivo' : 'ajuste_negativo';
        const absCant = Math.abs(numCant);

        await db.transaction(async (tx) => {
            let loteRef = lote_id ? Number(lote_id) : null;

            if (numCant > 0) {
                // Ajuste positivo: sumar a un lote existente o crear uno nuevo
                if (loteRef) {
                    await tx.run('UPDATE lotes SET cantidad_actual = cantidad_actual + $1 WHERE id = $2 AND producto_id = $3', [absCant, loteRef, req.params.id]);
                } else {
                    const loteNum = `AJUSTE-${req.params.id}-${Date.now().toString().slice(-5)}`;
                    const { row: loteRow } = await tx.run(`
                        INSERT INTO lotes (producto_id, numero_lote, fecha_ingreso, fecha_vencimiento, cantidad_inicial, cantidad_actual, costo_unitario)
                        VALUES ($1, $2, CURRENT_DATE, $3, $4, $4, $5) RETURNING id
                    `, [req.params.id, loteNum, fecha_vencimiento || null, absCant, producto.precio_compra || 0]);
                    loteRef = loteRow.id;
                }
            } else {
                // Ajuste negativo (merma, faltante): descontar del lote específico o por FEFO
                if (loteRef) {
                    await tx.run('UPDATE lotes SET cantidad_actual = GREATEST(0, cantidad_actual - $1) WHERE id = $2 AND producto_id = $3', [absCant, loteRef, req.params.id]);
                } else {
                    let rest = absCant;
                    const lotes = await tx.all(`
                        SELECT * FROM lotes WHERE producto_id = $1 AND cantidad_actual > 0
                        ORDER BY (fecha_vencimiento IS NULL), fecha_vencimiento ASC, fecha_ingreso ASC
                    `, [req.params.id]);
                    for (const l of lotes) {
                        if (rest <= 0) break;
                        const tomar = Math.min(Number(l.cantidad_actual), rest);
                        await tx.run('UPDATE lotes SET cantidad_actual = cantidad_actual - $1 WHERE id = $2', [tomar, l.id]);
                        rest -= tomar;
                        if (!loteRef) loteRef = l.id;
                    }
                }
            }

            // Mantener stock_actual perfectamente sincronizado con la suma de sus lotes físicos
            await tx.run(`
                UPDATE productos
                SET stock_actual = (SELECT COALESCE(SUM(cantidad_actual), 0) FROM lotes WHERE producto_id = $1)
                WHERE id = $1
            `, [req.params.id]);
            await tx.run(`
                INSERT INTO movimientos_stock (producto_id, lote_id, tipo, cantidad, motivo, referencia_tipo, usuario_id)
                VALUES ($1, $2, $3, $4, $5, 'ajuste', $6)
            `, [req.params.id, loteRef, tipo, absCant, motivo || 'Ajuste manual', req.usuario.id]);
        });

        AlertasService.verificarStockProducto(req.params.id).catch(() => {});

        res.json(await db.one('SELECT * FROM productos WHERE id = $1', [req.params.id]));
    } catch (err) { next(err); }
});

router.get('/:id/movimientos', async (req, res, next) => {
    try {
        const movimientos = await db.all(`
            SELECT * FROM movimientos_stock WHERE producto_id = $1 ORDER BY fecha DESC LIMIT 200
        `, [req.params.id]);
        res.json(movimientos);
    } catch (err) { next(err); }
});

module.exports = router;
