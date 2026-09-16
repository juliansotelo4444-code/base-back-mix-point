const https = require('https');
const db = require('../db/pool');

const agent = new https.Agent({ rejectUnauthorized: false });

function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { agent }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(fetchUrl(res.headers.location));
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`Error al acceder al Google Sheet: HTTP ${res.statusCode}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

function parseCSVLine(text) {
    const result = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            if (inQuotes && text[i + 1] === '"') {
                cur += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (c === ',' && !inQuotes) {
            result.push(cur);
            cur = '';
        } else {
            cur += c;
        }
    }
    result.push(cur);
    return result;
}

function parseCSV(content) {
    const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length === 0) return [];
    
    const headers = parseCSVLine(lines[0]);
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const values = parseCSVLine(line);
        const row = {};
        headers.forEach((h, idx) => {
            row[h.trim()] = values[idx] !== undefined ? values[idx].trim() : '';
        });
        rows.push(row);
    }
    return rows;
}

function extraerSheetId(url) {
    const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return match ? match[1] : null;
}

/**
 * Sincroniza el catálogo de productos desde un Google Sheet
 */
async function sincronizarCatalogo(sheetUrl) {
    const sheetId = extraerSheetId(sheetUrl);
    if (!sheetId) throw new Error('URL de Google Sheets inválida.');

    const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
    const csvContent = await fetchUrl(exportUrl);
    const rows = parseCSV(csvContent);

    if (rows.length === 0) {
        throw new Error('El archivo de Google Sheets está vacío o no tiene encabezados válidos.');
    }

    // 1. Obtener categorías existentes
    const categoriasExistentes = await db.all('SELECT id, nombre FROM categorias_producto');
    const catMap = {};
    categoriasExistentes.forEach(c => {
        catMap[c.nombre.toLowerCase()] = c.id;
    });

    // Crear categorías nuevas si existen en el Sheet
    for (const r of rows) {
        const catName = r.categoria ? r.categoria.trim() : '';
        if (catName && !catMap[catName.toLowerCase()]) {
            const { row } = await db.run('INSERT INTO categorias_producto (nombre) VALUES ($1) ON CONFLICT (nombre) DO UPDATE SET nombre = EXCLUDED.nombre RETURNING id', [catName]);
            catMap[catName.toLowerCase()] = row.id;
        }
    }

    const admin = await db.one("SELECT id FROM usuarios WHERE rol = 'admin' LIMIT 1");
    const adminId = admin ? admin.id : null;

    let nuevos = 0;
    let actualizados = 0;

    for (const r of rows) {
        const nombre = r.nombre ? r.nombre.trim() : '';
        if (!nombre) continue;

        const catId = r.categoria ? catMap[r.categoria.trim().toLowerCase()] || null : null;
        const precio1kg = parseFloat(r.kg) || 0;
        const precio5kg = parseFloat(r.cincoKg) || (precio1kg > 0 ? Math.round(precio1kg * 0.95) : 0);
        const precio10kg = parseFloat(r.diezKg) || (precio5kg > 0 ? Math.round(precio5kg * 0.95) : 0);
        const precio25kg = parseFloat(r.veinticincoKg) || (precio10kg > 0 ? Math.round(precio10kg * 0.92) : 0);
        const precio30kg = parseFloat(r.treintaKg) || (precio25kg > 0 ? Math.round(precio25kg * 0.95) : 0);
        const precioCompra = Math.round(precio1kg * 0.70);
        const codigo = r.id ? 'MP-' + String(r.id).padStart(3, '0') : null;
        const descripcion = r.descripcion || null;
        const imagen = r.imagen || null;
        const unidadMedida = (r.tipoVenta && r.tipoVenta.toLowerCase().includes('unidad')) ? 'unidad' : 'kg';

        const existente = await db.one('SELECT id, stock_actual FROM productos WHERE LOWER(nombre) = LOWER($1) OR (codigo IS NOT NULL AND codigo = $2)', [nombre, codigo]);

        let prodId;
        if (existente) {
            prodId = existente.id;
            await db.run(`
                UPDATE productos SET
                    codigo = COALESCE($1, codigo),
                    categoria_id = COALESCE($2, categoria_id),
                    descripcion = COALESCE($3, descripcion),
                    imagen = COALESCE($4, imagen),
                    unidad_medida = $5,
                    precio_venta = $6,
                    precio_5kg = $7,
                    precio_10kg = $8,
                    precio_25kg = $9,
                    precio_30kg = $10,
                    precio_compra = $11,
                    stock_actual = GREATEST(stock_actual, 100),
                    activo = true
                WHERE id = $12
            `, [codigo, catId, descripcion, imagen, unidadMedida, precio1kg, precio5kg, precio10kg, precio25kg, precio30kg, precioCompra, prodId]);
            actualizados++;
        } else {
            const { row } = await db.run(`
                INSERT INTO productos (
                    codigo, nombre, descripcion, imagen, categoria_id, unidad_medida,
                    precio_compra, precio_venta, precio_5kg, precio_10kg, precio_25kg, precio_30kg,
                    stock_minimo, stock_actual, activo
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 20, 100, true)
                RETURNING id
            `, [codigo, nombre, descripcion, imagen, catId, unidadMedida, precioCompra, precio1kg, precio5kg, precio10kg, precio25kg, precio30kg]);
            prodId = row.id;
            nuevos++;
        }

        // Asegurar que tenga lote con fecha de vencimiento adecuada
        const loteExistente = await db.one('SELECT id FROM lotes WHERE producto_id = $1 AND cantidad_actual > 0', [prodId]);
        if (!loteExistente) {
            const loteNum = `LOT-${String(prodId).padStart(3, '0')}-2026`;
            const { row: loteRow } = await db.run(`
                INSERT INTO lotes (
                    producto_id, numero_lote, fecha_ingreso, fecha_vencimiento,
                    cantidad_inicial, cantidad_actual, costo_unitario
                ) VALUES ($1, $2, CURRENT_DATE, '2027-12-31', 100, 100, $3)
                RETURNING id
            `, [prodId, loteNum, precioCompra]);

            await db.run(`
                INSERT INTO movimientos_stock (producto_id, lote_id, tipo, cantidad, motivo, referencia_tipo, usuario_id)
                VALUES ($1, $2, 'ingreso', 100, 'Sincronización Google Sheets', 'ajuste', $3)
            `, [prodId, loteRow.id, adminId]);
        }
    }

    return {
        ok: true,
        total: rows.length,
        nuevos,
        actualizados
    };
}

module.exports = {
    fetchUrl,
    parseCSV,
    extraerSheetId,
    sincronizarCatalogo
};
