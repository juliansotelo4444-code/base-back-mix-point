const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', requireRole('admin'), async (req, res, next) => {
    try {
        const usuarios = await db.all('SELECT id, nombre, email, rol, activo, created_at FROM usuarios ORDER BY nombre');
        res.json(usuarios);
    } catch (err) { next(err); }
});

router.post('/', requireRole('admin'), async (req, res, next) => {
    try {
        const { nombre, email, password, rol } = req.body;
        if (!nombre || !email || !password) return res.status(400).json({ error: 'nombre, email y password son requeridos.' });

        const existe = await db.one('SELECT id FROM usuarios WHERE email = $1', [email]);
        if (existe) return res.status(409).json({ error: 'Ya existe un usuario con ese email.' });

        const hash = bcrypt.hashSync(password, 10);
        const { row } = await db.run(
            `INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES ($1, $2, $3, $4) RETURNING id`,
            [nombre, email, hash, rol || 'ventas']
        );

        res.status(201).json({ id: row.id, nombre, email, rol: rol || 'ventas' });
    } catch (err) { next(err); }
});

router.put('/:id', requireRole('admin'), async (req, res, next) => {
    try {
        const existente = await db.one('SELECT * FROM usuarios WHERE id = $1', [req.params.id]);
        if (!existente) return res.status(404).json({ error: 'Usuario no encontrado.' });

        const { nombre, rol, activo, password } = req.body;
        const campos = {
            nombre: nombre ?? existente.nombre,
            rol: rol ?? existente.rol,
            activo: activo ?? existente.activo
        };

        await db.run('UPDATE usuarios SET nombre=$1, rol=$2, activo=$3 WHERE id=$4',
            [campos.nombre, campos.rol, campos.activo, req.params.id]);

        if (password) {
            const hash = bcrypt.hashSync(password, 10);
            await db.run('UPDATE usuarios SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
        }

        const actualizado = await db.one('SELECT id, nombre, email, rol, activo FROM usuarios WHERE id = $1', [req.params.id]);
        res.json(actualizado);
    } catch (err) { next(err); }
});

module.exports = router;
