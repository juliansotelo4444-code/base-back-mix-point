const express = require('express');
const db = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const AuditService = require('../services/auditService');

const router = express.Router();

// Endpoint público para la tienda web / E-commerce (sin autenticación)
router.get('/public', async (req, res, next) => {
    try {
        const sql = `
            SELECT 
                p.id,
                p.codigo,
                p.nombre,
                p.descripcion,
                p.imagen,
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
                COALESCE(c.nombre, 'Varios') as categoria
            FROM productos p
            LEFT JOIN categorias_producto c ON c.id = p.categoria_id
            WHERE p.activo = true AND p.destacado_carrusel = true
            ORDER BY p.orden_carrusel ASC, p.id ASC
        `;
        const items = await db.all(sql);
        res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
        res.json(items);
    } catch (err) { next(err); }
});

router.use(requireAuth);

// Listar todos los productos en el carrusel de ofertas
router.get('/', async (req, res, next) => {
    try {
        const sql = `
            SELECT 
                p.id,
                p.codigo,
                p.nombre,
                p.descripcion,
                p.imagen,
                p.categoria_id,
                COALESCE(c.nombre, 'General') as categoria_nombre,
                p.unidad_medida,
                p.precio_compra,
                p.precio_venta,
                p.precio_5kg,
                p.precio_10kg,
                p.precio_25kg,
                p.precio_30kg,
                p.precio_oferta,
                p.stock_actual,
                p.stock_minimo,
                p.destacado_carrusel,
                p.badge_carrusel,
                p.orden_carrusel,
                p.activo
            FROM productos p
            LEFT JOIN categorias_producto c ON c.id = p.categoria_id
            WHERE p.destacado_carrusel = true AND p.activo = true
            ORDER BY p.orden_carrusel ASC, p.id ASC
        `;
        const items = await db.all(sql);
        res.json(items);
    } catch (err) { next(err); }
});

// Buscar productos disponibles en el catálogo para agregarlos al carrusel
router.get('/disponibles', async (req, res, next) => {
    try {
        const q = (req.query.q || '').trim();
        let sql = `
            SELECT 
                p.id,
                p.codigo,
                p.nombre,
                p.descripcion,
                p.imagen,
                p.categoria_id,
                COALESCE(c.nombre, 'General') as categoria_nombre,
                p.unidad_medida,
                p.precio_venta,
                p.precio_5kg,
                p.precio_10kg,
                p.precio_25kg,
                p.precio_30kg,
                p.stock_actual,
                p.destacado_carrusel,
                p.badge_carrusel,
                p.orden_carrusel
            FROM productos p
            LEFT JOIN categorias_producto c ON c.id = p.categoria_id
            WHERE p.activo = true
        `;
        const params = [];
        if (q) {
            params.push(`%${q}%`, `%${q}%`);
            sql += ` AND (p.nombre ILIKE $${params.length - 1} OR p.codigo ILIKE $${params.length})`;
        }
        sql += ` ORDER BY p.destacado_carrusel DESC, p.nombre ASC LIMIT 50`;
        const items = await db.all(sql, params);
        res.json(items);
    } catch (err) { next(err); }
});

// Agregar producto al carrusel
router.post('/agregar', async (req, res, next) => {
    try {
        const { producto_id, badge_carrusel = '🔥 OFERTA', precio_oferta = null } = req.body;
        if (!producto_id) return res.status(400).json({ error: 'producto_id es requerido.' });

        const prod = await db.one('SELECT * FROM productos WHERE id = $1', [producto_id]);
        if (!prod) return res.status(404).json({ error: 'Producto no encontrado.' });

        // Obtener el mayor orden actual + 1
        const maxOrdenRes = await db.one('SELECT COALESCE(MAX(orden_carrusel), 0) as max_orden FROM productos WHERE destacado_carrusel = true');
        const nuevoOrden = Number(maxOrdenRes?.max_orden || 0) + 1;

        await db.run(`
            UPDATE productos SET
                destacado_carrusel = true,
                badge_carrusel = $1,
                precio_oferta = $2,
                orden_carrusel = $3,
                modificado_en_app = true,
                updated_at = NOW()
            WHERE id = $4
        `, [badge_carrusel, precio_oferta ? Number(precio_oferta) : null, nuevoOrden, producto_id]);

        AuditService.registrar({
            usuario_id: req.usuario?.id,
            accion: 'AGREGO_CARRUSEL',
            entidad: 'productos',
            entidad_id: producto_id,
            detalles: { nombre: prod.nombre, badge: badge_carrusel, orden: nuevoOrden }
        }).catch(() => {});

        const actualizado = await db.one('SELECT * FROM productos WHERE id = $1', [producto_id]);
        res.json({ ok: true, producto: actualizado });
    } catch (err) { next(err); }
});

// Quitar producto del carrusel
router.post('/quitar', async (req, res, next) => {
    try {
        const { producto_id } = req.body;
        if (!producto_id) return res.status(400).json({ error: 'producto_id es requerido.' });

        await db.run(`
            UPDATE productos SET
                destacado_carrusel = false,
                modificado_en_app = true,
                updated_at = NOW()
            WHERE id = $1
        `, [producto_id]);

        AuditService.registrar({
            usuario_id: req.usuario?.id,
            accion: 'QUITO_CARRUSEL',
            entidad: 'productos',
            entidad_id: producto_id
        }).catch(() => {});

        res.json({ ok: true });
    } catch (err) { next(err); }
});

// Actualizar configuración en el carrusel (badge, orden, precio oferta)
router.put('/:id', async (req, res, next) => {
    try {
        const { badge_carrusel, orden_carrusel, precio_oferta, destacado_carrusel } = req.body;
        const prod = await db.one('SELECT * FROM productos WHERE id = $1', [req.params.id]);
        if (!prod) return res.status(404).json({ error: 'Producto no encontrado.' });

        const nuevoDestacado = destacado_carrusel !== undefined ? Boolean(destacado_carrusel) : prod.destacado_carrusel;
        const nuevoBadge = badge_carrusel !== undefined ? badge_carrusel : prod.badge_carrusel;
        const nuevoOrden = orden_carrusel !== undefined ? Number(orden_carrusel) : prod.orden_carrusel;
        const nuevoPrecioOferta = precio_oferta !== undefined ? (precio_oferta ? Number(precio_oferta) : null) : prod.precio_oferta;

        const { row } = await db.run(`
            UPDATE productos SET
                destacado_carrusel = $1,
                badge_carrusel = $2,
                orden_carrusel = $3,
                precio_oferta = $4,
                modificado_en_app = true,
                updated_at = NOW()
            WHERE id = $5
            RETURNING *
        `, [nuevoDestacado, nuevoBadge, nuevoOrden, nuevoPrecioOferta, req.params.id]);

        res.json(row || await db.one('SELECT * FROM productos WHERE id = $1', [req.params.id]));
    } catch (err) { next(err); }
});

// Reordenar productos del carrusel en bloque
router.post('/reordenar', async (req, res, next) => {
    try {
        const { ordenes } = req.body; // array de { id, orden }
        if (!Array.isArray(ordenes)) return res.status(400).json({ error: 'ordenes debe ser un array de { id, orden }.' });

        await db.transaction(async (tx) => {
            for (const item of ordenes) {
                if (item.id && item.orden !== undefined) {
                    await tx.run('UPDATE productos SET orden_carrusel = $1, modificado_en_app = true, updated_at = NOW() WHERE id = $2', [
                        Number(item.orden),
                        Number(item.id)
                    ]);
                }
            }
        });

        res.json({ ok: true, mensaje: 'Orden actualizado correctamente.' });
    } catch (err) { next(err); }
});

module.exports = router;
