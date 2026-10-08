const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/pool');
const { requireAuth, SECRET } = require('../middleware/auth');

const router = express.Router();

router.post('/login', async (req, res, next) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email y contraseña son requeridos.' });
        }

        const usuario = await db.one('SELECT * FROM usuarios WHERE email = $1 AND activo = true', [email]);
        if (!usuario) {
            return res.status(401).json({ error: 'Credenciales inválidas.' });
        }

        const passwordOk = bcrypt.compareSync(password, usuario.password_hash);
        if (!passwordOk) {
            return res.status(401).json({ error: 'Credenciales inválidas.' });
        }

        const token = jwt.sign(
            { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rol: usuario.rol },
            SECRET,
            { expiresIn: '1h' }
        );

        res.json({
            token,
            usuario: {
                id: usuario.id,
                nombre: usuario.nombre,
                email: usuario.email,
                rol: usuario.rol,
                permisos: usuario.permisos || [],
                preferencias: usuario.preferencias || {}
            },
            expires_in: 3600
        });
    } catch (err) { next(err); }
});

router.get('/me', requireAuth, async (req, res, next) => {
    try {
        const usuario = await db.one('SELECT id, nombre, email, rol, permisos, preferencias FROM usuarios WHERE id = $1', [req.usuario.id]);
        if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });
        res.json({
            usuario: {
                ...usuario,
                permisos: usuario.permisos || [],
                preferencias: usuario.preferencias || {}
            }
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
