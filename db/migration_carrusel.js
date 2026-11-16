require('dotenv').config();
const db = require('./pool');

async function runMigration() {
    console.log('Verificando y ejecutando migración para Carrusel de Ofertas...');
    try {
        await db.query(`
            ALTER TABLE productos ADD COLUMN IF NOT EXISTS destacado_carrusel BOOLEAN NOT NULL DEFAULT FALSE;
            ALTER TABLE productos ADD COLUMN IF NOT EXISTS badge_carrusel TEXT DEFAULT '🔥 OFERTA';
            ALTER TABLE productos ADD COLUMN IF NOT EXISTS orden_carrusel INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE productos ADD COLUMN IF NOT EXISTS precio_oferta NUMERIC;
        `);

        // Si no hay productos destacados, inicializamos con los productos insignia para que no quede vacío
        const countRes = await db.one('SELECT COUNT(*) as total FROM productos WHERE destacado_carrusel = true');
        console.log(`Productos actualmente destacados en carrusel: ${countRes?.total || 0}`);

        if (Number(countRes?.total || 0) === 0) {
            console.log('Inicializando productos insignia por defecto en el carrusel...');
            const insigniaNombres = [
                { match: '%Patagonia%', badge: '🔥 MÁS PEDIDO', orden: 1 },
                { match: '%Almendra%Guara%', badge: '⭐ DESTACADO', orden: 2 },
                { match: '%Chandler%', badge: '✨ SELECCIÓN', orden: 3 },
                { match: '%Caj%', badge: '📦 MAYORISTA', orden: 4 },
                { match: '%Cervecero%', badge: '🔥 OFERTA', orden: 5 },
                { match: '%Premium%', badge: '✨ PREMIUM', orden: 6 }
            ];

            for (const ins of insigniaNombres) {
                await db.query(`
                    UPDATE productos
                    SET destacado_carrusel = true,
                        badge_carrusel = $1,
                        orden_carrusel = $2
                    WHERE id = (
                        SELECT id FROM productos
                        WHERE nombre ILIKE $3 AND activo = true
                        ORDER BY id ASC
                        LIMIT 1
                    )
                `, [ins.badge, ins.orden, ins.match]);
            }
        }

        const verificados = await db.all(`
            SELECT id, nombre, precio_venta, destacado_carrusel, badge_carrusel, orden_carrusel
            FROM productos
            WHERE destacado_carrusel = true
            ORDER BY orden_carrusel ASC
        `);
        console.log('Productos en carrusel:', verificados);
        console.log('Migración completada con éxito.');
        process.exit(0);
    } catch (err) {
        console.error('Error en migración:', err);
        process.exit(1);
    }
}

runMigration();
