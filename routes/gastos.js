const express = require('express');
const db = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { generarNumero } = require('../utils/numerador');

const router = express.Router();
router.use(requireAuth);

router.get('/categorias', async (req, res, next) => {
    try {
        res.json(await db.all('SELECT * FROM categorias_gasto ORDER BY nombre'));
    } catch (err) { next(err); }
});

router.post('/categorias', async (req, res, next) => {
    try {
        const { nombre, descripcion } = req.body;
        if (!nombre) return res.status(400).json({ error: 'nombre es requerido.' });
        const { row } = await db.run(
            'INSERT INTO categorias_gasto (nombre, descripcion) VALUES ($1, $2) ON CONFLICT (nombre) DO UPDATE SET nombre = EXCLUDED.nombre RETURNING id',
            [nombre, descripcion || null]
        );
        res.status(201).json({ id: row.id, nombre, descripcion });
    } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
    try {
        const { categoria_id, desde, hasta } = req.query;
        let sql = `
            SELECT g.*, c.nombre as categoria_nombre, p.razon_social as proveedor_nombre
            FROM gastos g
            JOIN categorias_gasto c ON c.id = g.categoria_id
            LEFT JOIN proveedores p ON p.id = g.proveedor_id
            WHERE 1=1
        `;
        const params = [];
        if (categoria_id) { params.push(categoria_id); sql += ` AND g.categoria_id = $${params.length}`; }
        if (desde) { params.push(desde); sql += ` AND g.fecha >= $${params.length}`; }
        if (hasta) { params.push(hasta); sql += ` AND g.fecha <= $${params.length}`; }
        sql += ' ORDER BY g.fecha DESC, g.id DESC';

        res.json(await db.all(sql, params));
    } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
    try {
        const { categoria_id, proveedor_id, fecha, descripcion, monto, metodo_pago, numero_comprobante } = req.body;
        if (!categoria_id || !descripcion || !monto) {
            return res.status(400).json({ error: 'categoria_id, descripcion y monto son requeridos.' });
        }

        const numero = await generarNumero('gastos', 'GAS');
        const { row } = await db.run(`
            INSERT INTO gastos (numero, categoria_id, proveedor_id, fecha, descripcion, monto, metodo_pago, numero_comprobante, usuario_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id
        `, [numero, categoria_id, proveedor_id || null, fecha || new Date().toISOString().slice(0, 10), descripcion, monto, metodo_pago || 'efectivo', numero_comprobante || null, req.usuario.id]);

        res.status(201).json(await db.one('SELECT * FROM gastos WHERE id = $1', [row.id]));
    } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
    try {
        const existente = await db.one('SELECT * FROM gastos WHERE id = $1', [req.params.id]);
        if (!existente) return res.status(404).json({ error: 'Gasto no encontrado.' });

        const g = { ...existente, ...req.body };
        await db.run(`
            UPDATE gastos SET categoria_id=$1, proveedor_id=$2, fecha=$3, descripcion=$4, monto=$5, metodo_pago=$6, numero_comprobante=$7
            WHERE id = $8
        `, [g.categoria_id, g.proveedor_id, g.fecha, g.descripcion, g.monto, g.metodo_pago, g.numero_comprobante, req.params.id]);

        res.json(await db.one('SELECT * FROM gastos WHERE id = $1', [req.params.id]));
    } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
    try {
        const existente = await db.one('SELECT * FROM gastos WHERE id = $1', [req.params.id]);
        if (!existente) return res.status(404).json({ error: 'Gasto no encontrado.' });
        await db.run('DELETE FROM gastos WHERE id = $1', [req.params.id]);
        res.json({ ok: true });
    } catch (err) { next(err); }
});

module.exports = router;
