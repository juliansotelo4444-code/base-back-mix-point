const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
    sincronizarCatalogo,
    fetchUrl,
    parseCSV,
    extraerSheetId,
    sanitizarNumero,
    sincronizarUnidireccional,
    sincronizarBidireccional,
    obtenerCodigoAppsScript,
    getSyncStatus
} = require('../services/googleSheets');
const { generarNumero } = require('../utils/numerador');
const db = require('../db/pool');
const AlertasService = require('../services/alertasService');

const router = express.Router();

const DEFAULT_CATALOGO_URL = process.env.GOOGLE_SHEET_CATALOGO_URL || 'https://docs.google.com/spreadsheets/d/1PC-DPIePHgDQPXt7sGuXCObJyO2YAiMOyTS1clAvTao/edit?usp=sharing';
const DEFAULT_PEDIDOS_URL = process.env.GOOGLE_SHEET_PEDIDOS_URL || 'https://docs.google.com/spreadsheets/d/1uJfkTvjqm_TEySTLJx2YW1fIViIrryjXl6IpDMlcPtk/edit?usp=sharing';

/**
 * Middleware híbrido: acepta x-mixpoint-token o sesión de usuario activa
 */
async function authOrWebhookToken(req, res, next) {
    const tokenHeader = req.headers['x-mixpoint-token'];
    if (tokenHeader) {
        // Consultar token configurado o aceptar el predeterminado
        const cfgToken = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'sheets_webhook_token'");
        const validToken = (cfgToken && cfgToken.valor) ? cfgToken.valor : 'MIXPOINT_SECRET_KEY';
        if (tokenHeader === validToken) {
            req.esWebhook = true;
            return next();
        }
    }
    return requireAuth(req, res, next);
}

/**
 * Endpoint de Webhook seguro para Google Apps Script
 * Modo: Sincronización Unidireccional Estricta (Google Sheets -> Postgres)
 * Responde de inmediato a Apps Script y ejecuta la sincronización en segundo plano sin latencia.
 */
router.post('/sheets-webhook', authOrWebhookToken, async (req, res, next) => {
    try {
        const { evento, fila, columna, valor } = req.body;
        console.log(`[Google Sheets Webhook Inbound] Evento recibido: ${evento || 'EDIT'} (Fila: ${fila}, Col: ${columna})`);

        // Disparar sincronización unidireccional en segundo plano sin bloquear el webhook
        sincronizarUnidireccional().catch(e => console.error('[Sheets Webhook Sync Error]:', e.message));

        await db.run(`
            INSERT INTO sync_logs (tipo, resultado, detalles, fecha)
            VALUES ('webhook_inbound', 'recibido', $1, NOW())
        `, [JSON.stringify(req.body)]);

        res.json({
            ok: true,
            mensaje: 'Webhook recibido con éxito. Sincronización unidireccional ejecutándose en segundo plano.',
            modo: 'unidireccional_estricto',
            evento: evento || 'EDIT'
        });
    } catch (err) {
        next(err);
    }
});

// A partir de aquí, las rutas administrativas requieren autenticación o token
router.use(authOrWebhookToken);

/**
 * Obtener configuración actual de Google Sheets
 */
router.get('/config', async (req, res, next) => {
    try {
        const rows = await db.all("SELECT clave, valor FROM configuracion_sistema WHERE clave LIKE 'sheets_%'");
        const configMap = {};
        rows.forEach(r => { configMap[r.clave] = r.valor; });

        res.json({
            catalogo_url: configMap.sheets_catalogo_url || DEFAULT_CATALOGO_URL,
            pedidos_url: configMap.sheets_pedidos_url || DEFAULT_PEDIDOS_URL,
            script_url: configMap.sheets_script_url || '',
            webhook_token: configMap.sheets_webhook_token || 'MIXPOINT_SECRET_KEY',
            auto_sync_interval: configMap.sheets_auto_sync_min || '5'
        });
    } catch (err) {
        next(err);
    }
});

/**
 * Guardar configuración de Google Sheets
 */
router.post('/config', async (req, res, next) => {
    try {
        const { catalogo_url, pedidos_url, script_url, webhook_token, auto_sync_interval } = req.body;

        const entries = [
            ['sheets_catalogo_url', catalogo_url],
            ['sheets_pedidos_url', pedidos_url],
            ['sheets_script_url', script_url],
            ['sheets_webhook_token', webhook_token],
            ['sheets_auto_sync_min', auto_sync_interval]
        ];

        for (const [clave, valor] of entries) {
            if (valor !== undefined) {
                await db.run(`
                    INSERT INTO configuracion_sistema (clave, valor, updated_at)
                    VALUES ($1, $2, NOW())
                    ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()
                `, [clave, String(valor)]);
            }
        }

        res.json({ ok: true, mensaje: 'Configuración guardada correctamente.' });
    } catch (err) {
        next(err);
    }
});

/**
 * Obtener código de Google Apps Script generado dinámicamente
 */
router.get('/apps-script-code', async (req, res, next) => {
    try {
        const host = req.get('host');
        const protocol = req.protocol;
        const backendUrl = `${protocol}://${host}`;

        const cfgToken = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'sheets_webhook_token'");
        const token = (cfgToken && cfgToken.valor) ? cfgToken.valor : 'MIXPOINT_SECRET_KEY';

        const code = obtenerCodigoAppsScript(backendUrl, token);
        res.json({ ok: true, backendUrl, token, code });
    } catch (err) {
        next(err);
    }
});

/**
 * Obtener estado en tiempo real de la sincronización
 */
router.get('/sync-status', (req, res) => {
    res.json(getSyncStatus());
});

/**
 * Sincronización manual / forzada unidireccional (Google Sheets -> PostgreSQL)
 */
router.post('/sync-unidireccional', async (req, res, next) => {
    try {
        const resultado = await sincronizarUnidireccional(req.body);
        res.json(resultado);
    } catch (err) {
        next(err);
    }
});

/**
 * Sincronización bidireccional (Compatibilidad: ejecuta sincronización unidireccional estricta hacia Postgres)
 */
router.post('/sync-bidireccional', async (req, res, next) => {
    try {
        const resultado = await sincronizarUnidireccional(req.body);
        res.json(resultado);
    } catch (err) {
        next(err);
    }
});

/**
 * Obtener logs recientes de sincronización
 */
router.get('/sync-logs', async (req, res, next) => {
    try {
        const logs = await db.all(`
            SELECT * FROM sync_logs 
            ORDER BY fecha DESC 
            LIMIT 50
        `);
        res.json({ logs });
    } catch (err) {
        next(err);
    }
});

/**
 * Sincronizar catálogo unidireccional (compatibilidad)
 */
router.post('/sync-catalogo', async (req, res, next) => {
    try {
        const cfg = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'sheets_catalogo_url'");
        const url = req.body.url || (cfg && cfg.valor) || DEFAULT_CATALOGO_URL;
        const resultado = await sincronizarCatalogo(url);
        res.json(resultado);
    } catch (err) {
        next(err);
    }
});

/**
 * Leer pedidos desde el Sheet de pedidos
 */
router.get('/pedidos-web', async (req, res, next) => {
    try {
        const cfg = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'sheets_pedidos_url'");
        const url = req.query.url || (cfg && cfg.valor) || DEFAULT_PEDIDOS_URL;
        if (!url) {
            return res.json({ pedidos: [], mensaje: 'Configurá el enlace de tu Google Sheet de pedidos.' });
        }

        const sheetId = extraerSheetId(url);
        if (!sheetId) return res.status(400).json({ error: 'URL de Google Sheet inválida.' });

        const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
        const csvContent = await fetchUrl(exportUrl);
        const rows = parseCSV(csvContent);

        // Obtener remitos existentes para saber cuáles pedidos ya fueron procesados
        const remitosExistentes = await db.all("SELECT id, numero, observaciones FROM remitos WHERE observaciones LIKE '%MP-%'");
        const remitosMap = {};
        remitosExistentes.forEach(r => {
            const m = r.observaciones ? r.observaciones.match(/MP-\d+/) : null;
            if (m) remitosMap[m[0]] = { id: r.id, numero: r.numero };
        });

        // Obtener catálogo para matchear productos
        const productosDB = await db.all('SELECT id, codigo, nombre, unidad_medida, precio_venta, stock_actual FROM productos WHERE activo = true');

function normalizarTexto(str) {
    if (!str) return '';
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();
}

function parsearItemsProductos(productosStr, productosDB) {
    if (!productosStr) return [];
    const lineas = productosStr.split(/[|\r\n;]+/).map(s => s.trim()).filter(Boolean);

    return lineas.map(raw => {
        let nombre = raw;
        let unidad = 'kg';
        let cantidad = 1;
        let subtotalDeclarado = null;
        let precioUnitarioDeclarado = null;

        // 1. Extraer precio/subtotal entre corchetes tipo [$4.700] o [4700]
        const precioMatch = nombre.match(/\[\s*\$?\s*([0-9.,]+)\s*\]/);
        if (precioMatch) {
            subtotalDeclarado = sanitizarNumero(precioMatch[1]);
            nombre = nombre.replace(precioMatch[0], '').trim();
        }

        // 2. Extraer cantidad tipo "x1", "x 2", "x2.5" al final o antes de corchetes
        const cantMatch = nombre.match(/(?:^|\s)x\s*(\d+(?:[.,]\d+)?)\s*$/i) ||
                          nombre.match(/(?:^|\s)x\s*(\d+(?:[.,]\d+)?)(?:\s|$)/i);
        if (cantMatch) {
            cantidad = sanitizarNumero(cantMatch[1]) || 1;
            nombre = (nombre.slice(0, cantMatch.index) + ' ' + nombre.slice(cantMatch.index + cantMatch[0].length)).trim();
        } else {
            const cantPrefixMatch = nombre.match(/^(\d+(?:[.,]\d+)?)\s*x\s+/i);
            if (cantPrefixMatch) {
                cantidad = sanitizarNumero(cantPrefixMatch[1]) || 1;
                nombre = nombre.slice(cantPrefixMatch[0].length).trim();
            }
        }

        // 3. Extraer unidad tipo "(1kg)", "(unidad)", "(500g)"
        const regexParen = /\((.*?)\)/g;
        let pMatch;
        while ((pMatch = regexParen.exec(nombre)) !== null) {
            const dentro = pMatch[1].trim().toLowerCase();
            if (dentro.includes('unidad') || dentro.includes('u') || dentro === 'un') {
                unidad = 'unidad';
                nombre = nombre.replace(pMatch[0], '').trim();
                break;
            } else if (dentro.includes('kg') || dentro.includes('kilo')) {
                unidad = 'kg';
                nombre = nombre.replace(pMatch[0], '').trim();
                break;
            } else if (dentro.includes('g') && !dentro.includes('kg')) {
                unidad = 'g';
                nombre = nombre.replace(pMatch[0], '').trim();
                break;
            }
        }

        nombre = nombre.replace(/\s+/g, ' ').replace(/^[-–—]\s*/, '').replace(/\s*[-–—]$/, '').trim();

        if (subtotalDeclarado && cantidad > 0) {
            precioUnitarioDeclarado = Math.round(subtotalDeclarado / cantidad);
        }

        const normNombre = normalizarTexto(nombre);

        let match = productosDB.find(p => normalizarTexto(p.nombre) === normNombre);
        if (!match) {
            match = productosDB.find(p => {
                const pNorm = normalizarTexto(p.nombre);
                return pNorm === normNombre || pNorm.startsWith(normNombre) || normNombre.startsWith(pNorm);
            });
        }
        if (!match) {
            match = productosDB.find(p => {
                const pNorm = normalizarTexto(p.nombre);
                return pNorm.includes(normNombre) || normNombre.includes(pNorm);
            });
        }

        const precioFinal = (match && Number(match.precio_venta) > 0) ? Number(match.precio_venta) : (precioUnitarioDeclarado || 0);
        const subtotalFinal = (precioFinal > 0) ? (precioFinal * cantidad) : (subtotalDeclarado || 0);

        return {
            raw,
            nombreOriginal: nombre,
            nombre: match ? match.nombre : nombre,
            producto_id: match ? match.id : null,
            codigo: match ? match.codigo : null,
            unidad_medida: match ? match.unidad_medida : unidad,
            precio_unitario: precioFinal,
            cantidad,
            subtotal: subtotalFinal,
            stock_actual: match ? Number(match.stock_actual) : 0,
            es_nuevo: !match
        };
    });
}

        const pedidosProcesados = rows.map(r => {
            const normalizado = {};
            Object.keys(r).forEach(k => {
                normalizado[k.trim().toLowerCase()] = r[k];
            });

            const numero = normalizado.numero || '';
            const fecha = normalizado.fecha || '';
            const nombre = normalizado.nombre || '';
            const telefono = normalizado.telefono || '';
            const direccion = normalizado.direccion || '';
            const zona = normalizado.zona || '';
            const productosStr = normalizado.productos || '';
            const total = sanitizarNumero(normalizado.total);

            // Parsear ítems con soporte para múltiples formatos y corchetes de precios
            const itemsParsed = parsearItemsProductos(productosStr, productosDB);

            const remitoAsociado = remitosMap[numero] || null;

            return {
                numero,
                fecha,
                nombre,
                telefono,
                direccion,
                zona,
                direccion_completa: [direccion, zona].filter(Boolean).join(', '),
                productos_str: productosStr,
                items: itemsParsed,
                total,
                remito_asociado: remitoAsociado
            };
        });

        res.json({ pedidos: pedidosProcesados.reverse() });
    } catch (err) {
        next(err);
    }
});

/**
 * Convierte un pedido web en un remito comercial en un solo paso
 */
router.post('/crear-remito-desde-pedido', async (req, res, next) => {
    try {
        const { pedido_numero, fecha, nombre, telefono, direccion_completa, items } = req.body;

        if (!nombre) return res.status(400).json({ error: 'El nombre del cliente es requerido.' });
        if (!items || !items.length) return res.status(400).json({ error: 'El pedido no contiene ítems.' });

        const adminUser = await db.one("SELECT id FROM usuarios WHERE rol = 'admin' LIMIT 1");
        const usuarioId = req.usuario ? req.usuario.id : (adminUser ? adminUser.id : 1);

        const remitoId = await db.transaction(async (tx) => {
            // 1. Buscar o crear cliente
            let cliente = await tx.one('SELECT id, direccion, telefono FROM clientes WHERE LOWER(razon_social) = LOWER($1)', [nombre.trim()]);
            if (!cliente) {
                const { row } = await tx.run(
                    `INSERT INTO clientes (razon_social, direccion, telefono, condicion_iva, lista_precio, saldo_cuenta)
                     VALUES ($1, $2, $3, 'Consumidor Final', 'kg', 0) RETURNING id`,
                    [nombre.trim(), direccion_completa || null, telefono || null]
                );
                cliente = row;
            } else if (direccion_completa || telefono) {
                await tx.run(
                    `UPDATE clientes SET
                        direccion = COALESCE(direccion, $1),
                        telefono = COALESCE(telefono, $2)
                     WHERE id = $3`,
                    [direccion_completa, telefono, cliente.id]
                );
            }

            // 2. Generar número correlativo
            const numero = await generarNumero('remitos', 'REM', tx);
            const observaciones = req.body.observaciones || (pedido_numero ? `Pedido Web ${pedido_numero}` : '');

            const { row: remitoRow } = await tx.run(
                `INSERT INTO remitos (numero, cliente_id, fecha, direccion_entrega, transportista, observaciones, total, usuario_id)
                 VALUES ($1, $2, CURRENT_DATE, $3, 'Distribución propia', $4, 0, $5) RETURNING id`,
                [numero, cliente.id, direccion_completa || null, observaciones, usuarioId]
            );

            const rId = remitoRow.id;
            let totalCalculado = 0;

            // 3. Crear ítems y descontar stock por FEFO garantizando que NINGÚN ÍTEM se pierda
            for (const it of items) {
                const cant = Number(it.cantidad) || 1;
                let precio = Number(it.precio_unitario) || 0;
                let productoId = it.producto_id;

                // Si el ítem no tiene producto_id, buscar en DB o crear el producto en el catálogo
                if (!productoId) {
                    const nombreBuscado = it.nombre || it.nombreOriginal || it.raw || 'Producto Sin Nombre';
                    const normNom = normalizarTexto(nombreBuscado);
                    let prodExistente = await tx.one('SELECT id, precio_venta, unidad_medida FROM productos WHERE LOWER(nombre) = LOWER($1)', [nombreBuscado.trim()]);
                    if (!prodExistente) {
                        const todosProds = await tx.all('SELECT id, nombre, precio_venta, unidad_medida FROM productos WHERE activo = true');
                        prodExistente = todosProds.find(p => normalizarTexto(p.nombre) === normNom || normalizarTexto(p.nombre).includes(normNom) || normNom.includes(normalizarTexto(p.nombre)));
                    }

                    if (prodExistente) {
                        productoId = prodExistente.id;
                        if (!precio && Number(prodExistente.precio_venta) > 0) {
                            precio = Number(prodExistente.precio_venta);
                        }
                    } else {
                        const nuevoCodigo = await generarNumero('productos', 'MP', tx);
                        const { row: nuevoProd } = await tx.run(`
                            INSERT INTO productos (codigo, nombre, unidad_medida, precio_venta, stock_actual, activo)
                            VALUES ($1, $2, $3, $4, 100, true) RETURNING id
                        `, [nuevoCodigo, nombreBuscado.trim(), it.unidad_medida || 'kg', precio]);
                        productoId = nuevoProd.id;
                    }
                }

                // Asegurar que exista un lote disponible en lotes para trazabilidad FEFO
                let lotes = await tx.all(`
                    SELECT * FROM lotes WHERE producto_id = $1 AND cantidad_actual > 0
                    ORDER BY (fecha_vencimiento IS NULL), fecha_vencimiento ASC, fecha_ingreso ASC
                `, [productoId]);

                if (!lotes || lotes.length === 0) {
                    const loteNum = `LOT-${String(productoId).padStart(3, '0')}-2026`;
                    const { row: nuevoLote } = await tx.run(`
                        INSERT INTO lotes (producto_id, numero_lote, fecha_ingreso, fecha_vencimiento, cantidad_inicial, cantidad_actual, costo_unitario)
                        VALUES ($1, $2, CURRENT_DATE, '2027-12-31', 100, 100, $3) RETURNING *
                    `, [productoId, loteNum, Math.round(precio * 0.7)]);
                    lotes = [nuevoLote];
                }

                let cantidadRestante = cant;
                let loteRef = null;
                for (const lote of lotes) {
                    if (cantidadRestante <= 0) break;
                    const tomar = Math.min(Number(lote.cantidad_actual), cantidadRestante);
                    await tx.run('UPDATE lotes SET cantidad_actual = cantidad_actual - $1 WHERE id = $2', [tomar, lote.id]);
                    cantidadRestante -= tomar;
                    if (!loteRef) loteRef = lote.id;
                }

                if (!loteRef && lotes.length > 0) {
                    loteRef = lotes[0].id;
                }

                const subtotalItem = Math.round(cant * precio * 100) / 100;
                totalCalculado += subtotalItem;

                await tx.run(`
                    INSERT INTO remito_items (remito_id, producto_id, lote_id, cantidad, precio_unitario, subtotal)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [rId, productoId, loteRef, cant, precio, subtotalItem]);

                await tx.run('UPDATE productos SET stock_actual = stock_actual - $1 WHERE id = $2', [cant, productoId]);

                await tx.run(`
                    INSERT INTO movimientos_stock (producto_id, lote_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
                    VALUES ($1, $2, 'egreso', $3, $4, 'remito', $5, $6)
                `, [productoId, loteRef, cant, `Remito Web ${pedido_numero || ''}`, rId, usuarioId]);
            }

            // Actualizar total definitivo del remito
            const total = totalCalculado;
            await tx.run('UPDATE remitos SET total = $1 WHERE id = $2', [total, rId]);

            // Actualizar cuenta corriente del cliente si el remito tiene monto
            if (Number(total) > 0) {
                await tx.run('UPDATE clientes SET saldo_cuenta = saldo_cuenta + $1 WHERE id = $2', [total, cliente.id]);
                await tx.run(`
                    INSERT INTO movimientos_cuenta (entidad_tipo, entidad_id, tipo, monto, medio_pago, referencia_tipo, referencia_id, observaciones, usuario_id)
                    VALUES ('cliente', $1, 'cargo', $2, 'cuenta_corriente', 'remito', $3, $4, $5)
                `, [cliente.id, total, rId, `Remito Web ${pedido_numero} (${numero})`, usuarioId]);
            }

            return rId;
        });

        // Alerta de stock para productos vendidos
        if (items && items.length > 0) {
            AlertasService.verificarMultiplesProductos(items.map(i => i.producto_id)).catch(() => {});
        }

        res.status(201).json(await db.one('SELECT * FROM remitos WHERE id = $1', [remitoId]));
    } catch (err) {
        next(err);
    }
});

module.exports = router;
