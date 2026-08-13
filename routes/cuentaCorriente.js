const express = require('express');
const db = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/**
 * Registrar un cobro (a cliente) o pago (a proveedor).
 * body: { entidad_tipo: 'cliente'|'proveedor', entidad_id, tipo: 'cobro'|'pago', monto, medio_pago, observaciones }
 */
router.post('/', async (req, res, next) => {
    try {
        const { entidad_tipo, entidad_id, tipo, monto, medio_pago, observaciones } = req.body;

        if (!['cliente', 'proveedor'].includes(entidad_tipo)) return res.status(400).json({ error: 'entidad_tipo inválido.' });
        if (!['cobro', 'pago', 'ajuste', 'cargo'].includes(tipo)) return res.status(400).json({ error: 'tipo inválido.' });
        if (!entidad_id || !monto) return res.status(400).json({ error: 'entidad_id y monto son requeridos.' });

        const tabla = entidad_tipo === 'cliente' ? 'clientes' : 'proveedores';
        const entidad = await db.one(`SELECT * FROM ${tabla} WHERE id = $1`, [entidad_id]);
        if (!entidad) return res.status(404).json({ error: `${entidad_tipo} no encontrado.` });

        const signo = (tipo === 'cobro' || tipo === 'pago') ? -1 : 1;
        const deltaSaldo = signo * Math.abs(monto);

        await db.transaction(async (tx) => {
            await tx.run(`
                INSERT INTO movimientos_cuenta (entidad_tipo, entidad_id, tipo, monto, medio_pago, referencia_tipo, observaciones, usuario_id)
                VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7)
            `, [entidad_tipo, entidad_id, tipo, Math.abs(monto), medio_pago || 'efectivo', observaciones || null, req.usuario.id]);

            await tx.run(`UPDATE ${tabla} SET saldo_cuenta = saldo_cuenta + $1 WHERE id = $2`, [deltaSaldo, entidad_id]);
        });

        res.status(201).json(await db.one(`SELECT * FROM ${tabla} WHERE id = $1`, [entidad_id]));
    } catch (err) { next(err); }
});

module.exports = router;
