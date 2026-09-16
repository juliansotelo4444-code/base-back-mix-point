require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./pool');

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

async function importar() {
    console.log('🚀 Iniciando sincronización del catálogo Mix Point...');
    await db.initSchema();

    // 1. Obtener CSV
    const csvPath = path.join(__dirname, 'products.csv');
    if (!fs.existsSync(csvPath)) {
        throw new Error(`No se encontró el archivo CSV en ${csvPath}`);
    }
    const csvContent = fs.readFileSync(csvPath, 'utf8');
    const productosCSV = parseCSV(csvContent);
    console.log(`📄 Se encontraron ${productosCSV.length} productos en el CSV.`);

    // 2. Extraer y crear categorías únicas
    const categoriasSet = new Set();
    productosCSV.forEach(p => {
        if (p.categoria) categoriasSet.add(p.categoria.trim());
    });

    const catMap = {};
    for (const catName of categoriasSet) {
        let cat = await db.one('SELECT id FROM categorias_producto WHERE LOWER(nombre) = LOWER($1)', [catName]);
        if (!cat) {
            const { row } = await db.run('INSERT INTO categorias_producto (nombre) VALUES ($1) RETURNING id', [catName]);
            cat = row;
        }
        catMap[catName.toLowerCase()] = cat.id;
    }
    console.log(`✅ ${Object.keys(catMap).length} categorías verificadas/creadas.`);

    // 3. Crear usuario admin si no existe
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

    // 4. Crear clientes frecuentes si no hay clientes
    const totalClientes = await db.one('SELECT COUNT(*) FROM clientes');
    if (parseInt(totalClientes.count, 10) === 0) {
        const clientesDemo = [
            { razon_social: 'Dietética La Semilla', cuit: '30-71458923-8', condicion_iva: 'Responsable Inscripto', direccion: 'Av. Corrientes 4520, CABA', telefono: '11-4567-8901', email: 'lasemilla@dietetica.com', lista_precio: 'diezKg' },
            { razon_social: 'Almacén Natural Belgrano', cuit: '27-34589123-4', condicion_iva: 'Monotributo', direccion: 'Cabildo 2180, CABA', telefono: '11-3456-7890', email: 'almacenbelgrano@gmail.com', lista_precio: 'cincoKg' },
            { razon_social: 'Distribuidora San Martín', cuit: '30-70984512-2', condicion_iva: 'Responsable Inscripto', direccion: 'San Martín 1540, GBA Norte', telefono: '11-6789-0123', email: 'pedidos@distsanmartin.com.ar', lista_precio: 'veinticincoKg' },
            { razon_social: 'Consumidor Final / Mostrador', cuit: '00-00000000-0', condicion_iva: 'Consumidor Final', direccion: 'Retiro en depósito', telefono: '11-0000-0000', email: 'mostrador@mixpoint.com', lista_precio: 'kg' }
        ];
        for (const c of clientesDemo) {
            await db.run(
                `INSERT INTO clientes (razon_social, cuit, condicion_iva, direccion, telefono, email, lista_precio, saldo_cuenta)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
                [c.razon_social, c.cuit, c.condicion_iva, c.direccion, c.telefono, c.email, c.lista_precio]
            );
        }
        console.log('✅ Clientes demo iniciales creados.');
    }

    // 5. Insertar / Actualizar productos con stock y lotes iniciales
    let importados = 0;
    let actualizados = 0;

    for (const p of productosCSV) {
        const nombre = p.nombre ? p.nombre.trim() : '';
        if (!nombre) continue;

        const catId = p.categoria ? catMap[p.categoria.trim().toLowerCase()] || null : null;
        const precio1kg = parseFloat(p.kg) || 0;
        const precio5kg = parseFloat(p.cincoKg) || (precio1kg > 0 ? Math.round(precio1kg * 0.95) : 0);
        const precio10kg = parseFloat(p.diezKg) || (precio5kg > 0 ? Math.round(precio5kg * 0.95) : 0);
        const precio25kg = parseFloat(p.veinticincoKg) || (precio10kg > 0 ? Math.round(precio10kg * 0.92) : 0);
        const precio30kg = parseFloat(p.treintaKg) || (precio25kg > 0 ? Math.round(precio25kg * 0.95) : 0);
        const precioCompra = Math.round(precio1kg * 0.70);
        const codigo = 'MP-' + String(p.id).padStart(3, '0');
        const descripcion = p.descripcion || null;
        const imagen = p.imagen || null;

        const existente = await db.one('SELECT id, stock_actual FROM productos WHERE LOWER(nombre) = LOWER($1) OR codigo = $2', [nombre, codigo]);

        let prodId;
        if (existente) {
            prodId = existente.id;
            await db.run(`
                UPDATE productos SET
                    codigo = $1,
                    categoria_id = $2,
                    descripcion = $3,
                    imagen = $4,
                    precio_venta = $5,
                    precio_5kg = $6,
                    precio_10kg = $7,
                    precio_25kg = $8,
                    precio_30kg = $9,
                    precio_compra = $10,
                    stock_actual = GREATEST(stock_actual, 100)
                WHERE id = $11
            `, [codigo, catId, descripcion, imagen, precio1kg, precio5kg, precio10kg, precio25kg, precio30kg, precioCompra, prodId]);
            actualizados++;
        } else {
            const { row } = await db.run(`
                INSERT INTO productos (
                    codigo, nombre, descripcion, imagen, categoria_id, unidad_medida,
                    precio_compra, precio_venta, precio_5kg, precio_10kg, precio_25kg, precio_30kg,
                    stock_minimo, stock_actual, activo
                ) VALUES ($1, $2, $3, $4, $5, 'kg', $6, $7, $8, $9, $10, $11, 20, 100, true)
                RETURNING id
            `, [codigo, nombre, descripcion, imagen, catId, precioCompra, precio1kg, precio5kg, precio10kg, precio25kg, precio30kg]);
            prodId = row.id;
            importados++;
        }

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
                VALUES ($1, $2, 'ingreso', 100, 'Inventario inicial de catálogo Mix Point', 'ajuste', $3)
            `, [prodId, loteRow.id, adminId]);
        }
    }

    console.log(`\n🎉 Catálogo importado exitosamente:`);
    console.log(`- Nuevos productos: ${importados}`);
    console.log(`- Productos actualizados: ${actualizados}`);
    console.log(`- Total productos en catálogo: ${importados + actualizados}`);
}

importar()
    .then(() => {
        console.log('✨ Proceso finalizado con éxito.');
        process.exit(0);
    })
    .catch((err) => {
        console.error('❌ Error al importar catálogo:', err);
        process.exit(1);
    });
