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
            { expiresIn: '12h' }
        );

        res.json({
            token,
            usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rol: usuario.rol }
        });
    } catch (err) { next(err); }
});

router.get('/me', requireAuth, (req, res) => {
    res.json({ usuario: req.usuario });
});

module.exports = router;
