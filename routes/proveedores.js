const express = require('express');
const db = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
    try {
        const { q, activo } = req.query;
        let sql = 'SELECT * FROM proveedores WHERE 1=1';
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
        const proveedor = await db.one('SELECT * FROM proveedores WHERE id = $1', [req.params.id]);
        if (!proveedor) return res.status(404).json({ error: 'Proveedor no encontrado.' });
        res.json(proveedor);
    } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
    try {
        const { razon_social, cuit, condicion_iva, direccion, localidad, telefono, email, observaciones } = req.body;
        if (!razon_social) return res.status(400).json({ error: 'razon_social es requerido.' });

        const { row } = await db.run(`
            INSERT INTO proveedores (razon_social, cuit, condicion_iva, direccion, localidad, telefono, email, observaciones)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
        `, [razon_social, cuit || null, condicion_iva || 'Responsable Inscripto', direccion || null, localidad || null, telefono || null, email || null, observaciones || null]);

        res.status(201).json(await db.one('SELECT * FROM proveedores WHERE id = $1', [row.id]));
    } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
    try {
        const existente = await db.one('SELECT * FROM proveedores WHERE id = $1', [req.params.id]);
        if (!existente) return res.status(404).json({ error: 'Proveedor no encontrado.' });

        const p = { ...existente, ...req.body };
        await db.run(`
            UPDATE proveedores SET razon_social=$1, cuit=$2, condicion_iva=$3, direccion=$4, localidad=$5, telefono=$6, email=$7, observaciones=$8, activo=$9
            WHERE id = $10
        `, [p.razon_social, p.cuit, p.condicion_iva, p.direccion, p.localidad, p.telefono, p.email, p.observaciones, p.activo, req.params.id]);

        res.json(await db.one('SELECT * FROM proveedores WHERE id = $1', [req.params.id]));
    } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
    try {
        const existente = await db.one('SELECT * FROM proveedores WHERE id = $1', [req.params.id]);
        if (!existente) return res.status(404).json({ error: 'Proveedor no encontrado.' });
        await db.run('UPDATE proveedores SET activo = false WHERE id = $1', [req.params.id]);
        res.json({ ok: true });
    } catch (err) { next(err); }
});

router.get('/:id/cuenta-corriente', async (req, res, next) => {
    try {
        const movimientos = await db.all(`
            SELECT * FROM movimientos_cuenta WHERE entidad_tipo = 'proveedor' AND entidad_id = $1 ORDER BY fecha DESC
        `, [req.params.id]);
        res.json(movimientos);
    } catch (err) { next(err); }
});

module.exports = router;
