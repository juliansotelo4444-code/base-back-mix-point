const db = require('../db/pool');
const { fetchUrl, parseCSV, extraerSheetId, sanitizarNumero } = require('./googleSheets');
const { generarNumero } = require('../utils/numerador');

const DEFAULT_PEDIDOS_URL = 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit?usp=sharing';

function normalizarTexto(str) {
    if (!str) return '';
    return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function parsearItemsProductos(productosStr, productosDB) {
    if (!productosStr) return [];
    const lineas = productosStr.split(/[|\r\n;]+/).map(s => s.trim()).filter(Boolean);

    return lineas.map(raw => {
        let text = String(raw || '').trim();
        let unidad = 'kg';
        let cantidad = 1;
        let subtotalDeclarado = null;

        // 1. Extraer subtotal entre corchetes: [$15.000] o [15000]
        const precioMatch = text.match(/\[\s*\$?\s*([0-9.,]+)\s*\]/);
        if (precioMatch) {
            subtotalDeclarado = sanitizarNumero(precioMatch[1]);
            text = text.replace(precioMatch[0], ' ').trim();
        }

        // 2. Extraer gramos: 500g, 500 gr, 500gr, 500 gramos (dentro o fuera de paréntesis)
        const grMatch = text.match(/(?:^|[\s(])(\d+(?:[.,]\d+)?)\s*(?:g|gr|gramos)\b\)?/i);
        if (grMatch) {
            const gramos = parseFloat(grMatch[1].replace(',', '.'));
            if (gramos > 0) {
                cantidad = Math.round((gramos / 1000) * 1000) / 1000;
                unidad = 'kg';
                text = text.replace(grMatch[0], ' ');
            }
        } else {
            // 3. Extraer kilos: 2kg, 2.5 kg, 2 kilos, 2k (dentro o fuera de paréntesis)
            const kgMatch = text.match(/(?:^|[\s(])(\d+(?:[.,]\d+)?)\s*(?:kg|kilos?|k)\b\)?/i);
            if (kgMatch) {
                cantidad = parseFloat(kgMatch[1].replace(',', '.')) || 1;
                unidad = 'kg';
                text = text.replace(kgMatch[0], ' ');
            } else {
                // 4. Extraer unidades: 3 unidades, 3 u, 3 un, 3 unids (dentro o fuera de paréntesis)
                const unMatch = text.match(/(?:^|[\s(])(\d+(?:[.,]\d+)?)\s*(?:unidades?|unids?|un|u)\b\)?/i);
                if (unMatch) {
                    cantidad = parseFloat(unMatch[1].replace(',', '.')) || 1;
                    unidad = 'unidad';
                    text = text.replace(unMatch[0], ' ');
                } else {
                    // 5. Multiplicador explícito: x 3, 3x, x3, cant: 3, cantidad 3
                    const xMatch = text.match(/(?:^|[\s(])(?:x\s*(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*x|(?:cant|cantidad):?\s*(\d+(?:[.,]\d+)?))(?:\s|\)|$)/i);
                    if (xMatch) {
                        const val = xMatch[1] || xMatch[2] || xMatch[3];
                        cantidad = parseFloat(val.replace(',', '.')) || 1;
                        text = text.replace(xMatch[0], ' ');
                    } else {
                        // 6. Número al inicio: '2 Nuez Chandler' o '2.5 Almendras'
                        const numInicioMatch = text.match(/^(\d+(?:[.,]\d+)?)\s+([a-zA-ZáéíóúÁÉÍÓÚñÑ])/i);
                        if (numInicioMatch) {
                            cantidad = parseFloat(numInicioMatch[1].replace(',', '.')) || 1;
                            text = text.slice(numInicioMatch[1].length).trim();
                        } else {
                            // 7. Número aislado al final: 'Nuez Chandler 2'
                            const numFinMatch = text.match(/\s+(\d+(?:[.,]\d+)?)\s*$/i);
                            if (numFinMatch) {
                                cantidad = parseFloat(numFinMatch[1].replace(',', '.')) || 1;
                                text = text.slice(0, numFinMatch.index).trim();
                            }
                        }
                    }
                }
            }
        }

        // Limpiar paréntesis vacíos, sobrantes y guiones
        let nombre = text.replace(/\(\s*\)/g, ' ')
                         .replace(/[-–—•*>\s]+/g, ' ')
                         .trim();

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
                let productoId = it.producto_id ? parseInt(it.producto_id, 10) : null;
                const nombreBuscado = it.nombre || it.raw || 'Producto Sin Nombre';
                const normNom = normalizarTexto(nombreBuscado);

                let prodExistente = null;

                // 1. PRIORIDAD ABSOLUTA: Buscar por NOMBRE en el catálogo de PostgreSQL
                if (nombreBuscado && nombreBuscado !== 'Producto Sin Nombre') {
                    prodExistente = await tx.one('SELECT id, nombre, codigo, precio_venta, unidad_medida FROM productos WHERE LOWER(TRIM(nombre)) = LOWER(TRIM($1))', [nombreBuscado]);
                    if (!prodExistente) {
                        const todos = await tx.all('SELECT id, nombre, codigo, precio_venta, unidad_medida FROM productos WHERE activo = true');
                        prodExistente = todos.find(p => normalizarTexto(p.nombre) === normNom);
                        if (!prodExistente) {
                            prodExistente = todos.find(p => {
                                const pNorm = normalizarTexto(p.nombre);
                                return pNorm.startsWith(normNom) || normNom.startsWith(pNorm);
                            });
                        }
                    }
                }

                // 2. Si no existe por nombre pero vino ID, SOLO aceptarlo si el nombre en DB coincide
                if (!prodExistente && productoId && !isNaN(productoId)) {
                    const prodPorId = await tx.one('SELECT id, nombre, codigo, precio_venta, unidad_medida FROM productos WHERE id = $1', [productoId]);
                    if (prodPorId && (normalizarTexto(prodPorId.nombre) === normNom || !nombreBuscado || nombreBuscado === 'Producto Sin Nombre')) {
                        prodExistente = prodPorId;
                    }
                }

                // 3. Si no existe por nombre ni ID, buscar por código si el nombre es compatible
                if (!prodExistente && productoId && !isNaN(productoId)) {
                    const codBuscado = 'MP-' + String(productoId).padStart(3, '0');
                    const prodPorCod = await tx.one('SELECT id, nombre, codigo, precio_venta, unidad_medida FROM productos WHERE codigo = $1', [codBuscado]);
                    if (prodPorCod && (normalizarTexto(prodPorCod.nombre) === normNom || !nombreBuscado || nombreBuscado === 'Producto Sin Nombre')) {
                        prodExistente = prodPorCod;
                    }
                }

                if (prodExistente) {
                    productoId = prodExistente.id;
                    if (!precio) precio = Number(prodExistente.precio_venta) || 0;
                } else {
                    const cod = 'PROD-' + Math.floor(Math.random() * 9000 + 1000);
                    const { row: nuevoProd } = await tx.run(
                        `INSERT INTO productos (codigo, nombre, unidad_medida, precio_venta, stock_actual, stock_minimo, activo)
                         VALUES ($1, $2, 'kg', $3, 0, 5, true) RETURNING id`,
                        [cod, nombreBuscado.trim(), precio]
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
