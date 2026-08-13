// Carga datos iniciales: usuario admin, categorías básicas.
// Ejecutar una sola vez con: node db/seed.js
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./pool');

async function seed() {
    await db.initSchema();

    const adminEmail = 'admin@frutossecos.com';
    const existe = await db.one('SELECT id FROM usuarios WHERE email = $1', [adminEmail]);

    if (!existe) {
        const hash = bcrypt.hashSync('admin123', 10);
        await db.run(
            `INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES ($1, $2, $3, 'admin')`,
            ['Administrador', adminEmail, hash]
        );
        console.log('✅ Usuario admin creado -> email: admin@frutossecos.com / password: admin123');
    } else {
        console.log('ℹ️  Usuario admin ya existe, no se recrea.');
    }

    const categoriasProducto = ['Frutos secos', 'Frutas desecadas', 'Semillas', 'Mix / Snacks', 'Otros'];
    for (const c of categoriasProducto) {
        await db.run('INSERT INTO categorias_producto (nombre) VALUES ($1) ON CONFLICT (nombre) DO NOTHING', [c]);
    }

    const categoriasGasto = [
        ['Logística y flete', 'Transporte de mercadería, combustible'],
        ['Alquiler', 'Alquiler de depósito u oficina'],
        ['Servicios', 'Luz, agua, gas, internet'],
        ['Sueldos', 'Sueldos y cargas sociales'],
        ['Insumos de embalaje', 'Bolsas, cajas, etiquetas'],
        ['Impuestos', 'Impuestos y tasas'],
        ['Mantenimiento', 'Mantenimiento de equipos e instalaciones'],
        ['Otros', 'Gastos varios no clasificados'],
    ];
    for (const [nombre, desc] of categoriasGasto) {
        await db.run('INSERT INTO categorias_gasto (nombre, descripcion) VALUES ($1, $2) ON CONFLICT (nombre) DO NOTHING', [nombre, desc]);
    }

    console.log('✅ Categorías de productos y gastos cargadas.');
    console.log('🌱 Seed completo.');
    await db.pool.end();
}

seed().catch(err => {
    console.error('Error en el seed:', err);
    process.exit(1);
});
