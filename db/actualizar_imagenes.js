require('dotenv').config();
const db = require('./pool');
const fs = require('fs');
const path = require('path');

async function syncByNameOnly() {
    console.log('🔄 Sincronizando productos (imagen y precios por escala) emparejando estrictamente por NOMBRE...');
    const jsonPath = path.join(__dirname, '..', 'data', 'catalogo_completo.json');
    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

    let updated = 0;
    for (const jp of json.productos) {
        const res = await db.run(
            `UPDATE productos 
             SET imagen = $1, 
                 precio_venta = $2, 
                 precio_5kg = $3, 
                 precio_10kg = $4, 
                 precio_25kg = $5, 
                 precio_30kg = $6 
             WHERE LOWER(TRIM(nombre)) = LOWER(TRIM($7))`,
            [
                jp.imagen,
                jp.precio_venta || 0,
                jp.precio_5kg || 0,
                jp.precio_10kg || 0,
                jp.precio_25kg || 0,
                jp.precio_30kg || 0,
                jp.nombre
            ]
        );
        updated += (res.rowCount || 0);
    }

    console.log(`✅ Filas actualizadas por nombre exacto: ${updated}`);
    
    // Verificación
    const nuez = await db.one("SELECT id, codigo, nombre, imagen, precio_venta FROM productos WHERE LOWER(TRIM(nombre)) = 'nuez con cascara'");
    console.log('🔎 Verificación Nuez con cascara:', nuez);
    
    const pasas = await db.one("SELECT id, codigo, nombre, imagen, precio_venta FROM productos WHERE LOWER(TRIM(nombre)) = 'pasas de uva jumbo'");
    console.log('🔎 Verificación Pasas De Uva Jumbo:', pasas);

    await db.pool.end();
}

syncByNameOnly().catch(err => {
    console.error('Error al sincronizar:', err);
    process.exit(1);
});
