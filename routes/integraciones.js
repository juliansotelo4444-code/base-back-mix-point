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
    pushToGoogleSheets,
    obtenerCodigoAppsScript,
    getSyncStatus
} = require('../services/googleSheets');
const { generarNumero } = require('../utils/numerador');
const db = require('../db/pool');
const AlertasService = require('../services/alertasService');

const router = express.Router();

const DEFAULT_CATALOGO_URL = process.env.GOOGLE_SHEET_CATALOGO_URL || 'https://docs.google.com/spreadsheets/d/1PC-DPIePHgDQPXt7sGuXCObJyO2YAiMOyTS1clAvTao/edit?usp=sharing';
const DEFAULT_PEDIDOS_URL = process.env.GOOGLE_SHEET_PEDIDOS_URL || 'https://docs.google.com/spreadsheets/d/1uJfkTvjqm_TEySTLJx2YW1fIViIrryjXl6IpDMlcPtk/edit?usp=sharing';

function normalizarTexto(str) {
    if (!str) return '';
    return String(str).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function parsearItemsProductosLocal(productosStr, prodsDB = []) {
    if (!productosStr) return [];
    const lineas = productosStr.split(/[|\r\n;]+/).map(s => s.trim()).filter(Boolean);

    return lineas.map(raw => {
        let text = String(raw || '').trim();
        let unidad = 'kg';
        let cantidad = 1;
        let subtotalDeclarado = null;
        let precioUnitarioDeclarado = null;

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
                         .replace(/[-–—]+/g, ' ')
                         .replace(/\s+/g, ' ')
                         .trim();

        if (subtotalDeclarado && cantidad > 0) {
            precioUnitarioDeclarado = Math.round(subtotalDeclarado / cantidad);
        }

        const normNombre = normalizarTexto(nombre);
        let match = prodsDB.find(p => normalizarTexto(p.nombre) === normNombre);
        if (!match) {
            match = prodsDB.find(p => {
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

/**
 * Endpoint de recepción directa de Pedidos Web desde el E-commerce Gus-Gus
 * Registra el pedido en PostgreSQL (Neon), asigna correlativo oficial MP-XXXX y emite notificación
 */
router.post('/pedidos-web', async (req, res, next) => {
    try {
        const {
            nombre,
            telefono,
            direccion,
            zona,
            metodoPago,
            horarioEntrega,
            horario_entrega,
            notas,
            productos,
            items,
            total
        } = req.body;

        const horarioEntregaVal = String(horario_entrega || horarioEntrega || '').trim();

        if (!nombre || !String(nombre).trim()) {
            return res.status(400).json({ success: false, error: 'El nombre del cliente es obligatorio.' });
        }

        const maxResult = await db.one(`
            SELECT COALESCE(MAX(NULLIF(regexp_replace(numero, '[^0-9]', '', 'g'), '')::int), 154) as max_num FROM pedidos_web
        `);
        const maxNum = (maxResult && maxResult.max_num) ? parseInt(maxResult.max_num, 10) : 154;
        const nuevoNumero = 'MP-' + String(maxNum + 1).padStart(4, '0');

        const todosProds = await db.all('SELECT id, codigo, nombre, precio_venta, unidad_medida FROM productos WHERE activo = true');
        const itemsSaneados = (Array.isArray(items) ? items : []).map(it => {
            const nombreBuscado = it.nombre || it.raw || '';
            const normNom = normalizarTexto(nombreBuscado);

            // 1. Buscar coincidencia exacta o normalizada por nombre
            let match = todosProds.find(p => normalizarTexto(p.nombre) === normNom);
            if (!match && normNom) {
                match = todosProds.find(p => {
                    const pNorm = normalizarTexto(p.nombre);
                    return pNorm.startsWith(normNom) || normNom.startsWith(pNorm);
                });
            }

            if (match) {
                return {
                    ...it,
                    producto_id: match.id,
                    codigo: match.codigo,
                    nombre: match.nombre,
                    unidad_medida: it.unidad_medida || match.unidad_medida,
                    precio_unitario: Number(it.precio_unitario) || Number(match.precio_venta) || 0
                };
            }
            return it;
        });

        const { row: pedidoGuardado } = await db.run(`
            INSERT INTO pedidos_web (
                numero, cliente_nombre, telefono, direccion, zona, metodo_pago,
                horario_entrega, notas, productos_str, items, total, estado, origen, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, 'pendiente', 'web', NOW())
            RETURNING *
        `, [
            nuevoNumero,
            String(nombre).trim(),
            String(telefono || '').trim(),
            String(direccion || '').trim(),
            String(zona || '').trim(),
            String(metodoPago || 'No especificado').trim(),
            horarioEntregaVal || null,
            String(notas || '').trim(),
            String(productos || '').trim(),
            JSON.stringify(itemsSaneados),
            Number(total) || 0
        ]);

        try {
            const { emitirEventoDeposito } = require('../socket');
            emitirEventoDeposito('pedido_web_nuevo', pedidoGuardado);
        } catch {
            // Ignorar si socket no inicializado
        }

        res.status(201).json({
            success: true,
            numeroPedido: nuevoNumero,
            id: pedidoGuardado.id,
            mensaje: 'Pedido registrado con éxito en la base de datos'
        });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /pedidos-web/:id
 * Edición de Pedido Web antes de su emisión a remito (cambio de dirección, teléfono, productos, horario)
 */
router.put('/pedidos-web/:id', async (req, res, next) => {
    try {
        const param = String(req.params.id || '');
        const numId = parseInt(param, 10);
        const {
            cliente_nombre,
            telefono,
            direccion,
            zona,
            metodo_pago,
            horario_entrega,
            notas,
            items,
            total
        } = req.body;

        const existente = await db.one('SELECT * FROM pedidos_web WHERE id = $1 OR numero = $2', [isNaN(numId) ? -1 : numId, param]);
        if (!existente) return res.status(404).json({ error: 'Pedido web no encontrado.' });
        if (existente.estado === 'emitido' && existente.remito_id) {
            return res.status(400).json({ error: 'El pedido ya tiene un remito emitido. Para modificarlo, edita el remito correspondiente en la sección Remitos.' });
        }

        const itemsSaneados = (Array.isArray(items) ? items : []).map(it => {
            const cant = Number(it.cantidad) || 1;
            const pu = Number(it.precio_unitario) || 0;
            const sub = it.subtotal !== undefined && it.subtotal !== null ? Number(it.subtotal) : cant * pu;
            return {
                producto_id: it.producto_id ? Number(it.producto_id) : null,
                codigo: it.codigo || '',
                nombre: String(it.nombre || '').trim(),
                cantidad: cant,
                unidad_medida: it.unidad_medida || 'kg',
                precio_unitario: pu,
                subtotal: sub,
                escala: it.escala || '',
                multiplicador: Number(it.multiplicador) || 1,
                kilos_totales: it.kilos_totales ? Number(it.kilos_totales) : null
            };
        });

        const totalCalc = total !== undefined && total !== null
            ? Number(total)
            : itemsSaneados.reduce((acc, it) => acc + (Number(it.subtotal) || 0), 0);
        const productosStr = itemsSaneados.map(it => `${it.nombre || ''} x ${it.cantidad || 1} ${it.unidad_medida || 'kg'}`).join(' | ');

        const { row: actualizado } = await db.run(`
            UPDATE pedidos_web SET
                cliente_nombre = COALESCE($1, cliente_nombre),
                telefono = COALESCE($2, telefono),
                direccion = COALESCE($3, direccion),
                zona = COALESCE($4, zona),
                metodo_pago = COALESCE($5, metodo_pago),
                horario_entrega = COALESCE($6, horario_entrega),
                notas = COALESCE($7, notas),
                items = $8::jsonb,
                productos_str = $9,
                total = $10,
                modificado_en_app = true,
                updated_at = NOW()
            WHERE id = $11
            RETURNING *
        `, [
            cliente_nombre !== undefined ? String(cliente_nombre).trim() : null,
            telefono !== undefined ? String(telefono).trim() : null,
            direccion !== undefined ? String(direccion).trim() : null,
            zona !== undefined ? String(zona).trim() : null,
            metodo_pago !== undefined ? String(metodo_pago).trim() : null,
            horario_entrega !== undefined ? String(horario_entrega).trim() : null,
            notas !== undefined ? String(notas).trim() : null,
            JSON.stringify(itemsSaneados),
            productosStr,
            totalCalc,
            existente.id
        ]);

        try {
            const { emitirEventoDeposito } = require('../socket');
            emitirEventoDeposito('pedido_web_actualizado', actualizado);
        } catch {}

        res.json({ ok: true, pedido: actualizado });
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
 * Sincronización bidireccional segura:
 * Inbound protegido + Outbound hacia Google Sheets (si hay script configurado)
 */
router.post('/sync-bidireccional', async (req, res, next) => {
    try {
        const resultado = await sincronizarBidireccional(req.body);
        res.json(resultado);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/integraciones/catalogo-para-sheets
 * Devuelve el catálogo consolidado en formato JSON para que Google Apps Script lo descargue
 */
router.get('/catalogo-para-sheets', authOrWebhookToken, async (req, res, next) => {
    try {
        const productos = await db.all(`
            SELECT p.id, p.codigo, p.nombre, p.descripcion, p.imagen, c.nombre as categoria,
                   p.precio_venta, p.precio_5kg, p.precio_10kg, p.precio_25kg, p.precio_30kg,
                   p.stock_actual, p.stock_minimo, p.unidad_medida, p.activo, p.modificado_en_app
            FROM productos p
            LEFT JOIN categorias_producto c ON c.id = p.categoria_id
            WHERE p.activo = true
            ORDER BY c.nombre ASC, p.nombre ASC
        `);

        res.json({
            ok: true,
            total: productos.length,
            productos: productos.map(p => ({
                id: p.id,
                codigo: p.codigo || '',
                nombre: p.nombre,
                categoria: p.categoria || 'Sin Categoría',
                kg: Number(p.precio_venta || 0),
                cincoKg: Number(p.precio_5kg || 0),
                diezKg: Number(p.precio_10kg || 0),
                veinticincoKg: Number(p.precio_25kg || 0),
                treintaKg: Number(p.precio_30kg || 0),
                stock: Number(p.stock_actual || 0),
                tipoVenta: p.unidad_medida === 'unidad' ? 'unidad' : 'kg'
            }))
        });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/integraciones/exportar-catalogo-csv
 * Descarga el catálogo en formato CSV compatible directo con Google Sheets
 */
router.get('/exportar-catalogo-csv', async (req, res, next) => {
    try {
        const productos = await db.all(`
            SELECT p.id, p.codigo, p.nombre, p.descripcion, p.imagen, c.nombre as categoria,
                   p.precio_venta, p.precio_5kg, p.precio_10kg, p.precio_25kg, p.precio_30kg,
                   p.stock_actual, p.stock_minimo, p.unidad_medida
            FROM productos p
            LEFT JOIN categorias_producto c ON c.id = p.categoria_id
            WHERE p.activo = true
            ORDER BY c.nombre ASC, p.nombre ASC
        `);

        const escapeCSV = (str) => {
            if (str === null || str === undefined) return '';
            const s = String(str).replace(/"/g, '""');
            return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
        };

        const headers = ['codigo', 'nombre', 'categoria', 'kg', 'cincoKg', 'diezKg', 'veinticincoKg', 'treintaKg', 'stock', 'tipoVenta', 'descripcion'];
        const csvRows = [headers.join(',')];

        productos.forEach(p => {
            csvRows.push([
                escapeCSV(p.codigo || ''),
                escapeCSV(p.nombre || ''),
                escapeCSV(p.categoria || ''),
                Number(p.precio_venta || 0),
                Number(p.precio_5kg || 0),
                Number(p.precio_10kg || 0),
                Number(p.precio_25kg || 0),
                Number(p.precio_30kg || 0),
                Number(p.stock_actual || 0),
                escapeCSV(p.unidad_medida || 'kg'),
                escapeCSV(p.descripcion || '')
            ].join(','));
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="catalogo_mixpoint.csv"');
        res.send(csvRows.join('\r\n'));
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/integraciones/push-a-sheets
 * Envía los datos actuales de la base hacia Google Sheets
 */
router.post('/push-a-sheets', async (req, res, next) => {
    try {
        const resultado = await pushToGoogleSheets(req.body.script_url);
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
 * Leer pedidos web: prioriza la base de datos PostgreSQL (Neon) para máxima velocidad
 * Si aún no hay pedidos locales o se fuerza origen=sheets, consulta Google Sheets
 */
router.get('/pedidos-web', async (req, res, next) => {
    try {
        const productosDB = await db.all('SELECT id, codigo, nombre, unidad_medida, precio_venta, stock_actual FROM productos WHERE activo = true');

        const pedidosDBRows = await db.all(`
            SELECT pw.*, r.id AS remito_id_rel, r.numero AS remito_numero
            FROM pedidos_web pw
            LEFT JOIN remitos r ON pw.remito_id = r.id OR r.observaciones ILIKE '%' || pw.numero || '%'
            ORDER BY pw.id DESC
        `);

        // Si existen pedidos en la base de datos y no se pidió forzar Sheets
        if (pedidosDBRows.length > 0 && req.query.origen !== 'sheets') {
            const pedidosProcesados = pedidosDBRows.map(r => {
                let itemsParsed = [];
                try {
                    itemsParsed = Array.isArray(r.items) ? r.items : (typeof r.items === 'string' ? JSON.parse(r.items) : []);
                } catch {
                    itemsParsed = [];
                }

                // Autocompletar items estructurados parseando productos_str si items vino vacío
                if ((!itemsParsed || itemsParsed.length === 0) && r.productos_str) {
                    itemsParsed = parsearItemsProductosLocal(r.productos_str, productosDB);
                }

                const remitoAsociado = (r.remito_id || r.remito_id_rel)
                    ? { id: r.remito_id || r.remito_id_rel, numero: r.remito_numero }
                    : null;

                let horaLlegada = '';
                if (r.created_at) {
                    try {
                        const d = new Date(r.created_at);
                        horaLlegada = d.toLocaleTimeString('es-AR', {
                            timeZone: 'America/Argentina/Buenos_Aires',
                            hour: '2-digit',
                            minute: '2-digit',
                            hour12: false
                        });
                    } catch {
                        horaLlegada = '';
                    }
                }

                let horarioEntrega = r.horario_entrega || '';
                if (!horarioEntrega && r.notas) {
                    const matchHorario = r.notas.match(/\[Horario preferido:\s*([^\]]+)\]/i) || r.notas.match(/Horario preferido:\s*([^|\]]+)/i);
                    if (matchHorario) {
                        horarioEntrega = matchHorario[1].trim();
                    }
                }

                return {
                    id: r.id,
                    numero: r.numero || `MP-${String(r.id).padStart(4, '0')}`,
                    fecha: r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : '',
                    created_at: r.created_at,
                    hora: horaLlegada,
                    nombre: r.cliente_nombre || 'Cliente Web',
                    telefono: r.telefono || '',
                    direccion: r.direccion || '',
                    zona: r.zona || '',
                    direccion_completa: [r.direccion, r.zona].filter(Boolean).join(', '),
                    metodo_pago: r.metodo_pago || 'No especificado',
                    horario_entrega: horarioEntrega,
                    notas: r.notas,
                    productos_str: r.productos_str || '',
                    items: itemsParsed,
                    total: Number(r.total) || 0,
                    estado: r.estado,
                    origen: r.origen || 'web',
                    remito_asociado: remitoAsociado
                };
            });

            return res.json({
                pedidos: pedidosProcesados,
                origen: 'base_de_datos',
                total: pedidosProcesados.length
            });
        }

        // Fallback o lectura histórica desde Google Sheets
        const cfg = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'sheets_pedidos_url'");
        const url = req.query.url || (cfg && cfg.valor) || DEFAULT_PEDIDOS_URL;
        if (!url) {
            return res.json({ pedidos: [], mensaje: 'Sin pedidos en base de datos ni enlace de Sheets configurado.' });
        }

        const sheetId = extraerSheetId(url);
        if (!sheetId) return res.status(400).json({ error: 'URL de Google Sheet inválida.' });

        const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
        const csvContent = await fetchUrl(exportUrl);
        const rows = parseCSV(csvContent);

        const remitosExistentes = await db.all("SELECT id, numero, observaciones FROM remitos WHERE observaciones LIKE '%MP-%'");
        const remitosMap = {};
        remitosExistentes.forEach(r => {
            const m = r.observaciones ? r.observaciones.match(/MP-\d+/) : null;
            if (m) remitosMap[m[0]] = { id: r.id, numero: r.numero };
        });

        // Filtrar filas vacías para evitar pedidos en blanco
        const pedidosValidos = rows.filter(r => {
            const vals = Object.values(r).map(v => String(v || '').trim()).filter(Boolean);
            return vals.length > 0 && (r.Numero || r.Nombre || r.numero || r.nombre || r.Productos || r.productos);
        });

        const pedidosProcesados = pedidosValidos.map(r => {
            const normalizado = {};
            Object.keys(r).forEach(k => {
                normalizado[k.trim().toLowerCase()] = r[k];
            });

            const numero = normalizado.numero || '';
            const fecha = normalizado.fecha || '';
            const nombre = normalizado.nombre || 'Cliente Web';
            const telefono = normalizado.telefono || '';
            const direccion = normalizado.direccion || '';
            const zona = normalizado.zona || '';
            const productosStr = normalizado.productos || '';
            const total = sanitizarNumero(normalizado.total);

            const itemsParsed = parsearItemsProductosLocal(productosStr, productosDB);
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
                remito_asociado: remitoAsociado,
                origen: 'google_sheets'
            };
        });

        res.json({ pedidos: pedidosProcesados.reverse(), origen: 'google_sheets' });
    } catch (err) {
        next(err);
    }
});

/**
 * Importar pedidos históricos desde Google Sheets a la base de datos Neon
 */
router.post('/importar-historico-sheets', async (req, res, next) => {
    try {
        const cfg = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'sheets_pedidos_url'");
        const url = (cfg && cfg.valor) || DEFAULT_PEDIDOS_URL;
        const sheetId = extraerSheetId(url);
        if (!sheetId) return res.status(400).json({ error: 'URL de Google Sheets inválida.' });

        const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
        const csvContent = await fetchUrl(exportUrl);
        const rows = parseCSV(csvContent);

        const productosDB = await db.all('SELECT id, codigo, nombre, unidad_medida, precio_venta, stock_actual FROM productos WHERE activo = true');
        const remitosExistentes = await db.all("SELECT id, numero, observaciones FROM remitos WHERE observaciones LIKE '%MP-%'");
        const remitosMap = {};
        remitosExistentes.forEach(r => {
            const m = r.observaciones ? r.observaciones.match(/MP-\d+/) : null;
            if (m) remitosMap[m[0]] = r.id;
        });

        let importados = 0;
        for (const r of rows) {
            const norm = {};
            Object.keys(r).forEach(k => { norm[k.trim().toLowerCase()] = r[k]; });
            const numero = norm.numero || '';
            if (!numero || !norm.nombre) continue;

            const existe = await db.one('SELECT id FROM pedidos_web WHERE numero = $1', [numero]);
            if (!existe) {
                const remitoId = remitosMap[numero] || null;
                const estado = remitoId ? 'emitido' : 'pendiente';

                await db.run(`
                    INSERT INTO pedidos_web (
                        numero, cliente_nombre, telefono, direccion, zona,
                        metodo_pago, notas, productos_str, items, total, estado, remito_id, origen, created_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '[]'::jsonb, $9, $10, $11, 'sheets_historico', NOW())
                `, [
                    numero,
                    norm.nombre,
                    norm.telefono || '',
                    norm.direccion || '',
                    norm.zona || '',
                    norm.metodopago || norm['metodo de pago'] || 'No especificado',
                    norm.notas || '',
                    norm.productos || '',
                    sanitizarNumero(norm.total) || 0,
                    estado,
                    remitoId
                ]);
                importados++;
            }
        }

        res.json({ ok: true, importados, mensaje: `Se importaron ${importados} pedidos históricos a la base de datos.` });
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

        let itemsFinal = Array.isArray(items) ? items : [];
        if (!itemsFinal.length && req.body.productos_str) {
            const prodsDB = await db.all('SELECT id, codigo, nombre, unidad_medida, precio_venta, stock_actual FROM productos WHERE activo = true');
            itemsFinal = parsearItemsProductosLocal(req.body.productos_str, prodsDB);
        }
        if (!itemsFinal || !itemsFinal.length) return res.status(400).json({ error: 'El pedido no contiene ítems ni detalle de productos.' });

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
            let observaciones = req.body.observaciones;
            if (!observaciones) {
                const parts = [];
                if (pedido_numero) parts.push(`Pedido Web ${pedido_numero}`);
                if (req.body.horario_entrega) parts.push(`Horario: ${req.body.horario_entrega}`);
                observaciones = parts.join(' | ');
            }

            const { row: remitoRow } = await tx.run(
                `INSERT INTO remitos (numero, cliente_id, fecha, direccion_entrega, transportista, observaciones, total, estado, stock_descontado, usuario_id)
                 VALUES ($1, $2, CURRENT_DATE, $3, 'Distribución propia', $4, 0, 'en_preparacion', true, $5) RETURNING id`,
                [numero, cliente.id, direccion_completa || null, observaciones, usuarioId]
            );

            const rId = remitoRow.id;
            let totalCalculado = 0;
            let totalBultos = 0;
            let totalPesoKg = 0;

            // 3. Crear ítems y descontar stock por FEFO garantizando que NINGÚN ÍTEM se pierda
            for (const it of itemsFinal) {
                const cantBultos = Number(it.cantidad) || 1;
                let precio = Number(it.precio_unitario) || 0;
                let productoId = it.producto_id ? parseInt(it.producto_id, 10) : null;
                const nombreBuscado = it.nombre || it.nombreOriginal || it.raw || 'Producto Sin Nombre';
                const normNom = normalizarTexto(nombreBuscado);

                // Detección de escala mayorista (bultos cerrados / packs: 5kg, 10kg, 25kg, 30kg, etc.)
                let multiplicador = Number(it.multiplicador) || 1;
                const escalaStr = String(it.escala || it.escala_key || it.unidad_medida || '').toLowerCase().trim();
                const nombreLower = String(nombreBuscado).toLowerCase();

                if (multiplicador === 1) {
                    if (escalaStr.includes('30kg') || escalaStr.includes('30 kg') || escalaStr.includes('treintakg') || nombreLower.includes('x30kg') || nombreLower.includes('x 30kg')) {
                        multiplicador = 30;
                    } else if (escalaStr.includes('25kg') || escalaStr.includes('25 kg') || escalaStr.includes('veinticincokg') || nombreLower.includes('x25kg') || nombreLower.includes('x 25kg')) {
                        multiplicador = 25;
                    } else if (escalaStr.includes('10kg') || escalaStr.includes('10 kg') || escalaStr.includes('diezkg') || escalaStr.includes('pack x10') || nombreLower.includes('x10kg') || nombreLower.includes('x 10kg')) {
                        multiplicador = 10;
                    } else if (escalaStr.includes('5kg') || escalaStr.includes('5 kg') || escalaStr.includes('cincokg') || escalaStr.includes('pack x5') || nombreLower.includes('x5kg') || nombreLower.includes('x 5kg')) {
                        multiplicador = 5;
                    }
                }

                let prodExistente = null;

                // 1. PRIORIDAD ABSOLUTA: Buscar por NOMBRE en el catálogo de PostgreSQL
                // El nombre elegido por el cliente es la verdad de lo que compró
                if (nombreBuscado && nombreBuscado !== 'Producto Sin Nombre') {
                    prodExistente = await tx.one('SELECT id, nombre, codigo, precio_venta, unidad_medida FROM productos WHERE LOWER(TRIM(nombre)) = LOWER(TRIM($1))', [nombreBuscado]);
                    if (!prodExistente) {
                        const todosProds = await tx.all('SELECT id, nombre, codigo, precio_venta, unidad_medida FROM productos WHERE activo = true');
                        prodExistente = todosProds.find(p => normalizarTexto(p.nombre) === normNom);
                        if (!prodExistente) {
                            prodExistente = todosProds.find(p => {
                                const pNorm = normalizarTexto(p.nombre);
                                return pNorm.startsWith(normNom) || normNom.startsWith(pNorm);
                            });
                        }
                    }
                }

                // 2. Si no se encontró por nombre pero vino ID, SOLO aceptarlo si el nombre en DB es compatible
                if (!prodExistente && productoId && !isNaN(productoId)) {
                    const prodPorId = await tx.one('SELECT id, nombre, codigo, precio_venta, unidad_medida FROM productos WHERE id = $1', [productoId]);
                    if (prodPorId && (normalizarTexto(prodPorId.nombre) === normNom || !nombreBuscado || nombreBuscado === 'Producto Sin Nombre')) {
                        prodExistente = prodPorId;
                    }
                }

                // 3. Si no existe por nombre, intentar por código correlativo (ej: MP-351) si el nombre es compatible
                if (!prodExistente && productoId && !isNaN(productoId)) {
                    const codBuscado = 'MP-' + String(productoId).padStart(3, '0');
                    const prodPorCod = await tx.one('SELECT id, nombre, codigo, precio_venta, unidad_medida FROM productos WHERE codigo = $1', [codBuscado]);
                    if (prodPorCod && (normalizarTexto(prodPorCod.nombre) === normNom || !nombreBuscado || nombreBuscado === 'Producto Sin Nombre')) {
                        prodExistente = prodPorCod;
                    }
                }

                // 4. Asignar el producto existente o crearlo si de verdad es nuevo en el catálogo
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

                let cantidadTotal = cantBultos * multiplicador;
                if (it.kilos_totales && Number(it.kilos_totales) > 0) {
                    cantidadTotal = Number(it.kilos_totales);
                }

                const subtotalItem = (it.subtotal !== undefined && it.subtotal !== null && Number(it.subtotal) > 0)
                    ? Number(it.subtotal)
                    : Math.round(cantBultos * precio * 100) / 100;

                let precioUnitarioCalculado = 0;
                if (cantidadTotal > 0) {
                    precioUnitarioCalculado = Math.round((subtotalItem / cantidadTotal) * 100) / 100;
                } else {
                    precioUnitarioCalculado = precio;
                }

                let itemDescripcion = null;
                const unidadActual = (prodExistente?.unidad_medida || it.unidad_medida || 'kg').toLowerCase();
                if (multiplicador > 1) {
                    const esPack = escalaStr.includes('pack') || unidadActual === 'unidad';
                    const tipoBulto = esPack ? 'Pack' : 'Bolsa';
                    itemDescripcion = cantBultos > 1
                        ? `${cantBultos} ${tipoBulto}s x${multiplicador}${esPack ? 'u' : 'kg'}`
                        : `${tipoBulto} x${multiplicador}${esPack ? 'u' : 'kg'}`;
                } else if (it.escala && it.escala !== '1kg' && it.escala !== 'Unidad') {
                    itemDescripcion = String(it.escala);
                }

                let cantidadRestante = cantidadTotal;
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

                totalCalculado += subtotalItem;
                totalBultos += cantBultos;
                if (unidadActual !== 'unidad') {
                    totalPesoKg += cantidadTotal;
                }

                await tx.run(`
                    INSERT INTO remito_items (remito_id, producto_id, lote_id, cantidad, precio_unitario, subtotal, descripcion)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                `, [rId, productoId, loteRef, cantidadTotal, precioUnitarioCalculado, subtotalItem, itemDescripcion]);

                await tx.run(`
                    UPDATE productos 
                    SET stock_actual = (SELECT COALESCE(SUM(cantidad_actual), 0) FROM lotes WHERE producto_id = $1)
                    WHERE id = $1
                `, [productoId]);

                await tx.run(`
                    INSERT INTO movimientos_stock (producto_id, lote_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
                    VALUES ($1, $2, 'egreso', $3, $4, 'remito', $5, $6)
                `, [productoId, loteRef, cantidadTotal, `Remito Web ${pedido_numero || ''}`, rId, usuarioId]);
            }

            // Actualizar total definitivo del remito, bultos y peso
            const total = totalCalculado;
            await tx.run('UPDATE remitos SET total = $1, bultos = $2, peso_kg = $3 WHERE id = $4', [total, totalBultos || 1, totalPesoKg, rId]);

            // Actualizar cuenta corriente del cliente si el remito tiene monto
            if (Number(total) > 0) {
                await tx.run('UPDATE clientes SET saldo_cuenta = saldo_cuenta + $1 WHERE id = $2', [total, cliente.id]);
                await tx.run(`
                    INSERT INTO movimientos_cuenta (entidad_tipo, entidad_id, tipo, monto, medio_pago, referencia_tipo, referencia_id, observaciones, usuario_id)
                    VALUES ('cliente', $1, 'cargo', $2, 'cuenta_corriente', 'remito', $3, $4, $5)
                `, [cliente.id, total, rId, `Remito Web ${pedido_numero} (${numero})`, usuarioId]);
            }

            // 4. Actualizar estado del pedido web a 'emitido' en la base de datos
            await tx.run(
                `UPDATE pedidos_web SET estado = 'emitido', remito_id = $1 WHERE numero = $2 OR id = $3`,
                [rId, pedido_numero, req.body.pedido_id || null]
            );

            return rId;
        });

        try {
            const { emitirEventoDeposito } = require('../socket');
            emitirEventoDeposito('pedido_web_actualizado', { numero: pedido_numero, remito_id: remitoId });
        } catch {
            // Socket opcional
        }

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
