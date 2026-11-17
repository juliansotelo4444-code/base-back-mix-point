require('dotenv').config();
const db = require('../db/pool');
const fs = require('fs');
const path = require('path');

const assetsDir = path.join(__dirname, '../../frontend/public/assets');
const assetFiles = fs.readdirSync(assetsDir);

function normalizeName(str) {
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/por 1\s?kg|po 1kg|x 1kg|x1kg|caja x[0-9]+unid|\(caja[^\)]+\)|por [0-9]+[a-z]+|60cc|50cc|100gr|100cc/gi, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

async function matchAndUpdate() {
    console.log('Buscando coincidencias de fotos de la página de ventas (/assets/) para todos los productos...');
    const prods = await db.all("SELECT id, nombre, imagen FROM productos WHERE activo = true");
    console.log(`Analizando ${prods.length} productos...`);

    const assetsMap = assetFiles.map(file => {
        const baseName = file.replace(/\.[^.]+$/, '');
        const norm = normalizeName(baseName);
        return { file, norm, baseName };
    });

    let updatedCount = 0;
    const manualMappings = {
        'Flor de Tilo': '/assets/flor-de-tilo.jpg',
        'Burrito': '/assets/burrito.jpg',
        'Aceite De Coco Virgen': '/assets/aceite-coco.jpg',
        'Palo Amarillo': '/assets/palo-amarillo.jpg',
        'Chocolatinas sin azúcar (caja x50unid)': '/assets/Chocolate.jpg',
        'Tabletas Águila (caja x48 unid)': '/assets/tabletas-aguila.jpg',
        'Bolsa Bombón Suizo (x50 unid)': '/assets/Chocolate.jpg',
        'Barra de Chocolate con Stevia': '/assets/Chocolate.jpg',
        'Gingko Biloba po 1kg': '/assets/ginkgo-biloba.jpg',
        'Malva': '/assets/malva.jpg',
        'Manzanilla': '/assets/manzanilla.jpg',
        'Marcela': '/assets/marcela.jpg',
        'Melisa': '/assets/melisa.jpg',
        'Menta': '/assets/menta.jpg',
        'Mirra': '/assets/mirra.jpg',
        'Muña Muña': '/assets/muna-muna.jpg',
        'Orégano': '/assets/oregano.jpg',
        'Ortiga': '/assets/ortiga.jpg',
        'Pasionaria': '/assets/pasionaria.jpg',
        'Peperina': '/assets/peperina.jpg',
        'Pezuña de Vaca': '/assets/pesuna-de-vaca.jpg',
        'Pétalo de Rosas': '/assets/petalo-rosas.jpg',
        'Poleo': '/assets/poleo.jpg',
        'Salvia': '/assets/salvia.jpg',
        'Salvia Blanca': '/assets/salvia-blanca.jpg',
        'Sándalo': '/assets/sandalo.jpg',
        'Sen': '/assets/sen.jpg',
        'Sem x 1kg': '/assets/sen.jpg',
        'Siempre Viva': '/assets/siempre-viva.jpg',
        'Té Negro': '/assets/te-negro.jpg',
        'Té Rojo': '/assets/te-rojo.jpg',
        'Té Verde': '/assets/te-verde.jpg',
        'Valeriana': '/assets/valeriana.jpg',
        'Yerba de Pollo': '/assets/yerba-de-pollo.jpg',
        'Boldo': '/assets/boldo.jpg',
        'Calendula': '/assets/calendula.jpg',
        'Carqueja': '/assets/carqueja.jpg',
        'Cedrón': '/assets/cedron.jpg',
        'Centella Asiática': '/assets/centella-asiatica.jpg',
        'Chicoria': '/assets/amargon.jpg',
        'Cola de Caballo': '/assets/cola-de-caballo.jpg',
        'Congorosa': '/assets/congo-rosa.jpg',
        'Enebro': '/assets/enebro.jpg',
        'Equinacea': '/assets/equinacea.jpg',
        'Eucalipto': '/assets/eucalipto.jpg',
        'Fucus': '/assets/fucus.jpg',
        'Incienso': '/assets/incienso.jpg',
        'Jengibre': '/assets/jengibre.jpg',
        'Lavanda': '/assets/lavanda.jpg',
        'Lapacho': '/assets/lapacho.jpg',
        'Llantén': '/assets/llanten.jpg'
    };

    for (const p of prods) {
        let nuevoPath = null;

        // 1. Verificar mapeo manual exacto
        for (const [key, val] of Object.entries(manualMappings)) {
            if (p.nombre.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(p.nombre.toLowerCase())) {
                nuevoPath = val;
                break;
            }
        }

        // 2. Si no hay mapeo manual y la imagen actual es /catalogo/ o rota
        if (!nuevoPath && (p.imagen?.startsWith('/catalogo/') || !p.imagen?.startsWith('/assets/'))) {
            const pNorm = normalizeName(p.nombre);
            const match = assetsMap.find(a => a.norm === pNorm || a.norm.includes(pNorm) || (pNorm.length > 4 && pNorm.includes(a.norm)));
            if (match) {
                nuevoPath = `/assets/${match.file}`;
            }
        }

        if (nuevoPath && nuevoPath !== p.imagen) {
            await db.run(
                'UPDATE productos SET imagen = $1, modificado_en_app = true, updated_at = NOW() WHERE id = $2',
                [nuevoPath, p.id]
            );
            console.log(`✓ [Actualizado #${p.id}] ${p.nombre.padEnd(35)} : ${p.imagen} ➔ ${nuevoPath}`);
            updatedCount++;
        }
    }

    console.log(`\nTotal de productos actualizados a fotos de la tienda (/assets/): ${updatedCount}`);

    const stats = await db.one(`
        SELECT 
            count(*) as total,
            count(*) FILTER (WHERE imagen LIKE '/assets/%') as con_assets,
            count(*) FILTER (WHERE imagen LIKE '/catalogo/%') as con_catalogo_svg,
            count(*) FILTER (WHERE imagen LIKE 'http%') as con_url_externa
        FROM productos WHERE activo = true
    `);
    console.log('Distribución final de imágenes en productos activos:', stats);

    process.exit(0);
}

matchAndUpdate().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
