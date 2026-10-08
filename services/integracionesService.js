const db = require('../db/pool');
const { fetchUrl, parseCSV, extraerSheetId, sanitizarNumero } = require('./googleSheets');
const { generarNumero } = require('../utils/correlativo');

const DEFAULT_PEDIDOS_URL = 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit?usp=sharing';

function normalizarTexto(str) {
    if (!str) return '';
    return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function parsearItemsProductos(productosStr, productosDB) {
    if (!productosStr) return [];
    const lineas = productosStr.split(/[|\r\n;]+/).map(s => s.trim()).filter(Boolean);

    return lineas.map(raw => {
        let nombre = raw;
        let unidad = 'kg';
        let cantidad = 1;
        let subtotalDeclarado = null;

        const precioMatch = nombre.match(/\[\s*\$?\s*([0-9.,]+)\s*\]/);
        if (precioMatch) {
            subtotalDeclarado = sanitizarNumero(precioMatch[1]);
            nombre = nombre.replace(precioMatch[0], '').trim();
        }

        const cantMatch = nombre.match(/(?:x|cant\.?|cantidad:?)\s*([0-9.,]+)(?:\s*(kg|kilos?|gr|gramos?|un|unidades?))?/i);
        if (cantMatch) {
            cantidad = sanitizarNumero(cantMatch[1]) || 1;
            if (cantMatch[2]) unidad = cantMatch[2].toLowerCase();
            nombre = nombre.replace(cantMatch[0], '').trim();
        }

        nombre = nombre.replace(/^[-•*>\s]+/, '').trim();
        const normNom = normalizarTexto(nombre);

        let match = productosDB.find(p => normalizarTexto(p.nombre) === normNom);
        if (!match) match = productosDB.find(p => normalizarTexto(p.nombre).includes(normNom) || normNom.includes(normalizarTexto(p.nombre)));

        let precioUnitario = match ? Number(match.precio_venta) : 0;
        let subtotal = subtotalDeclarado || Math.round(cantidad * precioUnitario * 100) / 100;
        if (subtotalDeclarado && !precioUnitario && cantidad > 0) {
            precioUnitario = Math.round((subtotalDeclarado / cantidad) * 100) / 100;
        }

        return {
            raw,
            producto_id: match ? match.id : null,
            codigo: match ? match.codigo : null,
            nombre: match ? match.nombre : nombre,
            nombreOriginal: nombre,
            cantidad,
            unidad_medida: match ? match.unidad_medida : unidad,
            precio_unitario: precioUnitario,
            subtotal,
            stock_disponible: match ? Number(match.stock_actual) : 0,
            matcheado: !!match
        };
    });
}

class IntegracionesService {
    static async obtenerPedidosWeb(urlPersonalizada = null) {
        const cfg = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'sheets_pedidos_url'");
        const url = urlPersonalizada || (cfg && cfg.valor) || DEFAULT_PEDIDOS_URL;
        if (!url) return { pedidos: [] };

        const sheetId = extraerSheetId(url);
        if (!sheetId) return { pedidos: [] };

        const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
        const csvContent = await fetchUrl(exportUrl);
        const rows = parseCSV(csvContent);

        const remitosExistentes = await db.all("SELECT id, numero, observaciones FROM remitos WHERE observaciones LIKE '%MP-%' OR observaciones LIKE '%Pedido Web%'");
        const remitosMap = {};
        remitosExistentes.forEach(r => {
            const m = r.observaciones ? r.observaciones.match(/MP-\d+/) : null;
            if (m) remitosMap[m[0]] = { id: r.id, numero: r.numero };
        });

        const productosDB = await db.all('SELECT id, codigo, nombre, unidad_medida, precio_venta, stock_actual FROM productos WHERE activo = true');

        const pedidos = rows.map((r, idx) => {
            const numero = r['Número'] || r['Numero'] || r['ID'] || r['Nro'] || `MP-${1000 + idx + 1}`;
            const nombre = r['Nombre'] || r['Cliente'] || r['Destinatario'] || '';
            const productosStr = r['Productos'] || r['Detalle'] || r['Items'] || r['Pedido'] || '';
            const items = parsearItemsProductos(productosStr, productosDB);
            const total = items.reduce((acc, it) => acc + (it.subtotal || 0), 0);

            return {
                numero,
                fecha: r['Fecha'] || new Date().toISOString().slice(0, 10),
                nombre,
                telefono: r['Teléfono'] || r['Telefono'] || r['Celular'] || '',
                direccion: r['Dirección'] || r['Direccion'] || '',
                localidad: r['Localidad'] || r['Ciudad'] || '',
                zona: r['Zona'] || '',
                direccion_completa: [r['Dirección'] || r['Direccion'], r['Localidad'] || r['Ciudad'], r['Zona']].filter(Boolean).join(', '),
                items,
                total: Math.round(total * 100) / 100,
                remito_asociado: remitosMap[numero] || null
            };
        });

        return { pedidos };
    }

    static async crearRemitoDesdePedido({ pedido_numero, nombre, telefono, direccion_completa, transportista, items }) {
        if (!nombre) throw new Error('El nombre del cliente es obligatorio.');
        if (!items || !items.length) throw new Error('El pedido debe tener al menos un ítem.');

        const adminUser = await db.one("SELECT id FROM usuarios WHERE rol = 'admin' LIMIT 1");
        const usuarioId = adminUser ? adminUser.id : 1;

        return await db.transaction(async (tx) => {
            let cliente = await tx.one('SELECT id, direccion, telefono FROM clientes WHERE LOWER(razon_social) = LOWER($1)', [nombre.trim()]);
            if (!cliente) {
                const { row } = await tx.run(
                    `INSERT INTO clientes (razon_social, direccion, telefono, condicion_iva, lista_precio, saldo_cuenta)
                     VALUES ($1, $2, $3, 'Consumidor Final', 'kg', 0) RETURNING id`,
                    [nombre.trim(), direccion_completa || null, telefono || null]
                );
                cliente = row;
            }

            const numero = await generarNumero('remitos', 'REM', tx);
            const observaciones = pedido_numero ? `Pedido Web ${pedido_numero} - Auto Generado por Agente IA` : 'Auto Generado por Agente IA';

            const { row: remitoRow } = await tx.run(
                `INSERT INTO remitos (numero, cliente_id, fecha, direccion_entrega, transportista, observaciones, total, usuario_id, estado)
                 VALUES ($1, $2, CURRENT_DATE, $3, $4, $5, 0, $6, 'pendiente') RETURNING id, numero`,
                [numero, cliente.id, direccion_completa || null, transportista || 'Distribución propia', observaciones, usuarioId]
            );

            const rId = remitoRow.id;
            let totalCalculado = 0;

            for (const it of items) {
                const cant = Number(it.cantidad) || 1;
                let precio = Number(it.precio_unitario) || 0;
                let productoId = it.producto_id;

                if (!productoId) {
                    const normNom = normalizarTexto(it.nombre);
                    let prodExistente = await tx.one('SELECT id, precio_venta FROM productos WHERE LOWER(nombre) = LOWER($1)', [it.nombre.trim()]);
                    if (!prodExistente) {
                        const todos = await tx.all('SELECT id, nombre, precio_venta FROM productos WHERE activo = true');
                        prodExistente = todos.find(p => normalizarTexto(p.nombre) === normNom || normalizarTexto(p.nombre).includes(normNom));
                    }
                    if (prodExistente) {
                        productoId = prodExistente.id;
                        if (!precio) precio = Number(prodExistente.precio_venta) || 0;
                    }
                }

                if (!productoId) {
                    const cod = 'PROD-' + Math.floor(Math.random() * 9000 + 1000);
                    const { row: nuevoProd } = await tx.run(
                        `INSERT INTO productos (codigo, nombre, unidad_medida, precio_venta, stock_actual, stock_minimo, activo)
                         VALUES ($1, $2, 'kg', $3, 0, 5, true) RETURNING id`,
                        [cod, it.nombre.trim(), precio]
                    );
                    productoId = nuevoProd.id;
                }

                const subtotal = Math.round(cant * precio * 100) / 100;
                totalCalculado += subtotal;

                await tx.run(
                    `INSERT INTO remito_items (remito_id, producto_id, cantidad, precio_unitario, subtotal)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [rId, productoId, cant, precio, subtotal]
                );
            }

            await tx.run('UPDATE remitos SET total = $1 WHERE id = $2', [Math.round(totalCalculado * 100) / 100, rId]);

            return {
                id: rId,
                numero: remitoRow.numero,
                total: Math.round(totalCalculado * 100) / 100
            };
        });
    }
}

module.exports = IntegracionesService;
