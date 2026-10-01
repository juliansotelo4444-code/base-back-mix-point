require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./pool');

async function importarCatalogoOficial() {
    console.log('🚀 Iniciando sincronización del Catálogo Oficial Mix Point desde PDF...');
    await db.initSchema();

    const jsonPath = path.join(__dirname, '..', 'data', 'catalogo_completo.json');
    if (!fs.existsSync(jsonPath)) {
        throw new Error(`No se encontró el archivo ${jsonPath}`);
    }

    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    console.log(`📦 Cargados ${data.productos.length} productos y ${data.categorias.length} categorías.`);

    // 1. Crear / sincronizar categorías
    const catMap = {};
    for (const cat of data.categorias) {
        let dbCat = await db.one('SELECT id FROM categorias_producto WHERE LOWER(nombre) = LOWER($1)', [cat.nombre]);
        if (!dbCat) {
            const { row } = await db.run('INSERT INTO categorias_producto (nombre) VALUES ($1) RETURNING id', [cat.nombre]);
            dbCat = row;
        }
        catMap[cat.nombre.toLowerCase()] = dbCat.id;
    }
    console.log(`✅ ${Object.keys(catMap).length} categorías verificadas en la base de datos.`);

    // 2. Crear admin si no existe
    const admin = await db.one("SELECT id FROM usuarios WHERE email = 'admin@frutossecos.com'");
    let adminId = admin ? admin.id : null;
    if (!adminId) {
        const bcrypt = require('bcryptjs');
        const hash = bcrypt.hashSync('admin123', 10);
        const { row } = await db.run(
            `INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES ('Administrador Mix Point', 'admin@frutossecos.com', $1, 'admin') RETURNING id`,
            [hash]
        );
        adminId = row.id;
    }

    // 3. Sincronizar productos
    let importados = 0;
    let actualizados = 0;

    for (const p of data.productos) {
        const catId = catMap[p.categoria.toLowerCase()] || null;
        const precioVenta = Number(p.precio_venta) || 0;
        const precio5kg = Number(p.precio_5kg) || 0;
        const precio10kg = Number(p.precio_10kg) || 0;
        const precio25kg = Number(p.precio_25kg) || 0;
        const precio30kg = Number(p.precio_30kg) || 0;
        const precioCompra = Math.round(precioVenta * 0.75 * 100) / 100; // Costo estimado 75%
        const unidadMedida = p.unidad_medida || 'kg';

        // Buscar por nombre o código
        let prodDb = await db.one('SELECT id, stock_actual, codigo FROM productos WHERE LOWER(nombre) = LOWER($1) OR codigo = $2', [p.nombre, p.codigo]);

        if (prodDb) {
            await db.run(`
                UPDATE productos SET
                    nombre = $1,
                    descripcion = $2,
                    imagen = COALESCE($3, imagen),
                    categoria_id = $4,
                    unidad_medida = $5,
                    precio_venta = $6,
                    precio_5kg = $7,
                    precio_10kg = $8,
                    precio_25kg = $9,
                    precio_30kg = $10,
                    precio_compra = $11,
                    activo = TRUE
                WHERE id = $12
            `, [
                p.nombre, p.descripcion || null, p.imagen || null, catId, unidadMedida,
                precioVenta, precio5kg, precio10kg, precio25kg, precio30kg, precioCompra,
                prodDb.id
            ]);
            actualizados++;
        } else {
            // Asegurar código único
            let codigoFinal = p.codigo;
            let codeExists = await db.one('SELECT id FROM productos WHERE codigo = $1', [codigoFinal]);
            let counter = 100;
            while (codeExists) {
                codigoFinal = `MP-${String(counter++).padStart(3, '0')}`;
                codeExists = await db.one('SELECT id FROM productos WHERE codigo = $1', [codigoFinal]);
            }

            const { row } = await db.run(`
                INSERT INTO productos (
                    codigo, nombre, descripcion, imagen, categoria_id, unidad_medida,
                    precio_compra, precio_venta, precio_5kg, precio_10kg, precio_25kg, precio_30kg,
                    stock_minimo, stock_actual, activo
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 10, 150, TRUE)
                RETURNING id
            `, [
                codigoFinal, p.nombre, p.descripcion || null, p.imagen || null, catId, unidadMedida,
                precioCompra, precioVenta, precio5kg, precio10kg, precio25kg, precio30kg
            ]);
            prodDb = row;
            importados++;

            // Crear lote inicial con fecha de vencimiento a 12 meses para trazabilidad FEFO
            const hoy = new Date();
            const venc = new Date(hoy.getFullYear() + 1, hoy.getMonth(), hoy.getDate()).toISOString().slice(0, 10);
            await db.run(`
                INSERT INTO lotes (producto_id, numero_lote, fecha_ingreso, fecha_vencimiento, cantidad_inicial, cantidad_actual, costo_unitario)
                VALUES ($1, $2, CURRENT_DATE, $3, 150, 150, $4)
            `, [prodDb.id, `LOTE-${codigoFinal}-INI`, venc, precioCompra]);
        }
    }

    console.log(`✅ Catálogo sincronizado en Base de Datos: ${importados} creados, ${actualizados} actualizados.`);
    await db.pool.end();
}

importarCatalogoOficial().catch(err => {
    console.error('Error importando catálogo oficial:', err);
    process.exit(1);
});
