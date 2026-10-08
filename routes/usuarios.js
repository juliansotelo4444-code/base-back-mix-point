const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', requireRole('admin'), async (req, res, next) => {
    try {
        const usuarios = await db.all('SELECT id, nombre, email, rol, activo, permisos, created_at FROM usuarios ORDER BY nombre');
        res.json(usuarios.map(u => ({ ...u, permisos: u.permisos || [] })));
    } catch (err) { next(err); }
});

router.post('/', requireRole('admin'), async (req, res, next) => {
    try {
        const { nombre, email, password, rol, permisos } = req.body;
        if (!nombre || !email || !password) return res.status(400).json({ error: 'nombre, email y password son requeridos.' });

        const existe = await db.one('SELECT id FROM usuarios WHERE email = $1', [email]);
        if (existe) return res.status(409).json({ error: 'Ya existe un usuario con ese email.' });

        const hash = bcrypt.hashSync(password, 10);
        const permisosJson = JSON.stringify(Array.isArray(permisos) ? permisos : []);
        const { row } = await db.run(
            `INSERT INTO usuarios (nombre, email, password_hash, rol, permisos) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [nombre, email, hash, rol || 'ventas', permisosJson]
        );

        res.status(201).json({ id: row.id, nombre, email, rol: rol || 'ventas', permisos: Array.isArray(permisos) ? permisos : [] });
    } catch (err) { next(err); }
});

// Obtener preferencias del usuario autenticado
router.get('/me/preferencias', async (req, res, next) => {
    try {
        const usuario = await db.one('SELECT preferencias FROM usuarios WHERE id = $1', [req.usuario.id]);
        res.json({ preferencias: (usuario && usuario.preferencias) || {} });
    } catch (err) { next(err); }
});

// Guardar preferencias del usuario autenticado
router.put('/me/preferencias', async (req, res, next) => {
    try {
        const { preferencias } = req.body;
        if (!preferencias || typeof preferencias !== 'object') {
            return res.status(400).json({ error: 'El cuerpo debe incluir un objeto preferencias.' });
        }

        const usuarioActual = await db.one('SELECT preferencias FROM usuarios WHERE id = $1', [req.usuario.id]);
        const actual = (usuarioActual && usuarioActual.preferencias) || {};
        const fusionadas = { ...actual, ...preferencias };

        await db.run('UPDATE usuarios SET preferencias = $1 WHERE id = $2', [JSON.stringify(fusionadas), req.usuario.id]);
        res.json({ ok: true, preferencias: fusionadas });
    } catch (err) { next(err); }
});

router.put('/:id', requireRole('admin'), async (req, res, next) => {
    try {
        const existente = await db.one('SELECT * FROM usuarios WHERE id = $1', [req.params.id]);
        if (!existente) return res.status(404).json({ error: 'Usuario no encontrado.' });

        const { nombre, rol, activo, password, permisos } = req.body;
        const campos = {
            nombre: nombre ?? existente.nombre,
            rol: rol ?? existente.rol,
            activo: activo ?? existente.activo,
            permisos: permisos !== undefined ? JSON.stringify(Array.isArray(permisos) ? permisos : []) : existente.permisos
        };

        await db.run('UPDATE usuarios SET nombre=$1, rol=$2, activo=$3, permisos=$4 WHERE id=$5',
            [campos.nombre, campos.rol, campos.activo, campos.permisos, req.params.id]);

        if (password) {
            const hash = bcrypt.hashSync(password, 10);
            await db.run('UPDATE usuarios SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
        }

        const actualizado = await db.one('SELECT id, nombre, email, rol, activo, permisos FROM usuarios WHERE id = $1', [req.params.id]);
        res.json({ ...actualizado, permisos: actualizado.permisos || [] });
    } catch (err) { next(err); }
});

module.exports = router;
