const express = require('express');
const db = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

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
        const { q, activo, bajo_stock } = req.query;
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
        const { codigo, nombre, categoria_id, unidad_medida, precio_compra, precio_venta, stock_minimo } = req.body;
        if (!nombre) return res.status(400).json({ error: 'nombre es requerido.' });

        const { row } = await db.run(`
            INSERT INTO productos (codigo, nombre, categoria_id, unidad_medida, precio_compra, precio_venta, stock_minimo, stock_actual)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 0) RETURNING id
        `, [codigo || null, nombre, categoria_id || null, unidad_medida || 'kg', precio_compra || 0, precio_venta || 0, stock_minimo || 0]);

        res.status(201).json(await db.one('SELECT * FROM productos WHERE id = $1', [row.id]));
    } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
    try {
        const existente = await db.one('SELECT * FROM productos WHERE id = $1', [req.params.id]);
        if (!existente) return res.status(404).json({ error: 'Producto no encontrado.' });

        const p = { ...existente, ...req.body };
        await db.run(`
            UPDATE productos SET codigo=$1, nombre=$2, categoria_id=$3, unidad_medida=$4, precio_compra=$5, precio_venta=$6, stock_minimo=$7, activo=$8
            WHERE id = $9
        `, [p.codigo, p.nombre, p.categoria_id, p.unidad_medida, p.precio_compra, p.precio_venta, p.stock_minimo, p.activo, req.params.id]);

        res.json(await db.one('SELECT * FROM productos WHERE id = $1', [req.params.id]));
    } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
    try {
        const existente = await db.one('SELECT * FROM productos WHERE id = $1', [req.params.id]);
        if (!existente) return res.status(404).json({ error: 'Producto no encontrado.' });
        await db.run('UPDATE productos SET activo = false WHERE id = $1', [req.params.id]);
        res.json({ ok: true });
    } catch (err) { next(err); }
});

// Ajuste manual de stock (mermas, conteos físicos, etc.)
router.post('/:id/ajuste-stock', async (req, res, next) => {
    try {
        const { cantidad, motivo } = req.body;
        const producto = await db.one('SELECT * FROM productos WHERE id = $1', [req.params.id]);
        if (!producto) return res.status(404).json({ error: 'Producto no encontrado.' });
        if (cantidad === undefined || Number(cantidad) === 0) return res.status(400).json({ error: 'cantidad es requerida y debe ser distinta de 0.' });

        const tipo = Number(cantidad) > 0 ? 'ajuste_positivo' : 'ajuste_negativo';

        await db.transaction(async (tx) => {
            await tx.run('UPDATE productos SET stock_actual = stock_actual + $1 WHERE id = $2', [cantidad, req.params.id]);
            await tx.run(`
                INSERT INTO movimientos_stock (producto_id, tipo, cantidad, motivo, referencia_tipo, usuario_id)
                VALUES ($1, $2, $3, $4, 'ajuste', $5)
            `, [req.params.id, tipo, Math.abs(cantidad), motivo || 'Ajuste manual', req.usuario.id]);
        });

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
