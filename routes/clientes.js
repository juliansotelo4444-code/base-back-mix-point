const express = require('express');
const db = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
    try {
        const { q, activo } = req.query;
        let sql = 'SELECT * FROM clientes WHERE 1=1';
        const params = [];

        if (q) {
            params.push(`%${q}%`, `%${q}%`, `%${q}%`);
            sql += ` AND (razon_social ILIKE $${params.length - 2} OR cuit ILIKE $${params.length - 1} OR email ILIKE $${params.length})`;
        }
        if (activo !== undefined) {
            params.push(activo === '1');
            sql += ` AND activo = $${params.length}`;
        }
        sql += ' ORDER BY razon_social ASC';

        res.json(await db.all(sql, params));
    } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
    try {
        const cliente = await db.one('SELECT * FROM clientes WHERE id = $1', [req.params.id]);
        if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado.' });
        res.json(cliente);
    } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
    try {
        const { razon_social, cuit, condicion_iva, direccion, localidad, telefono, email, lista_precio, observaciones } = req.body;
        if (!razon_social) return res.status(400).json({ error: 'razon_social es requerido.' });

        const { row } = await db.run(`
            INSERT INTO clientes (razon_social, cuit, condicion_iva, direccion, localidad, telefono, email, lista_precio, observaciones)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id
        `, [razon_social, cuit || null, condicion_iva || 'Consumidor Final', direccion || null, localidad || null, telefono || null, email || null, lista_precio || 'general', observaciones || null]);

        res.status(201).json(await db.one('SELECT * FROM clientes WHERE id = $1', [row.id]));
    } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
    try {
        const existente = await db.one('SELECT * FROM clientes WHERE id = $1', [req.params.id]);
        if (!existente) return res.status(404).json({ error: 'Cliente no encontrado.' });

        const c = { ...existente, ...req.body };
        await db.run(`
            UPDATE clientes SET razon_social=$1, cuit=$2, condicion_iva=$3, direccion=$4, localidad=$5, telefono=$6, email=$7, lista_precio=$8, observaciones=$9, activo=$10
            WHERE id = $11
        `, [c.razon_social, c.cuit, c.condicion_iva, c.direccion, c.localidad, c.telefono, c.email, c.lista_precio, c.observaciones, c.activo, req.params.id]);

        res.json(await db.one('SELECT * FROM clientes WHERE id = $1', [req.params.id]));
    } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
    try {
        const existente = await db.one('SELECT * FROM clientes WHERE id = $1', [req.params.id]);
        if (!existente) return res.status(404).json({ error: 'Cliente no encontrado.' });
        await db.run('UPDATE clientes SET activo = false WHERE id = $1', [req.params.id]);
        res.json({ ok: true });
    } catch (err) { next(err); }
});

router.get('/:id/cuenta-corriente', async (req, res, next) => {
    try {
        const movimientos = await db.all(`
            SELECT * FROM movimientos_cuenta WHERE entidad_tipo = 'cliente' AND entidad_id = $1 ORDER BY fecha DESC
        `, [req.params.id]);
        res.json(movimientos);
    } catch (err) { next(err); }
});

module.exports = router;
