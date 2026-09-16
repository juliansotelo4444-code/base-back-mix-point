require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const db = require('./db/pool');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

app.get('/api/health', async (req, res) => {
    try {
        await db.query('SELECT 1');
        res.json({ ok: true, servicio: 'mix-point-api', db: 'conectada' });
    } catch (err) {
        res.status(500).json({ ok: false, error: 'No se pudo conectar a la base de datos.' });
    }
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/usuarios', require('./routes/usuarios'));
app.use('/api/clientes', require('./routes/clientes'));
app.use('/api/proveedores', require('./routes/proveedores'));
app.use('/api/productos', require('./routes/productos'));
app.use('/api/recepciones', require('./routes/recepciones'));
app.use('/api/remitos', require('./routes/remitos'));
app.use('/api/gastos', require('./routes/gastos'));
app.use('/api/cuenta-corriente', require('./routes/cuentaCorriente'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/integraciones', require('./routes/integraciones'));

app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor.' });
});

async function start() {
    try {
        await db.initSchema();
        console.log('📦 Esquema de base de datos verificado/creado.');
    } catch (err) {
        console.error('❌ No se pudo inicializar la base de datos:', err.message);
        process.exit(1);
    }

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🥭 API de Mix Point corriendo en http://0.0.0.0:${PORT}`);
    });
}

start();
