const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { sincronizarCatalogo, fetchUrl, parseCSV, extraerSheetId } = require('../services/googleSheets');
const { generarNumero } = require('../utils/numerador');
const db = require('../db/pool');

const router = express.Router();
router.use(requireAuth);

const DEFAULT_CATALOGO_URL = process.env.GOOGLE_SHEET_CATALOGO_URL || 'https://docs.google.com/spreadsheets/d/1PC-DPIePHgDQPXt7sGuXCObJyO2YAiMOyTS1clAvTao/edit?usp=sharing';
let pedidosUrl = process.env.GOOGLE_SHEET_PEDIDOS_URL || 'https://docs.google.com/spreadsheets/d/1uJfkTvjqm_TEySTLJx2YW1fIViIrryjXl6IpDMlcPtk/edit?usp=sharing';

router.get('/config', (req, res) => {
    res.json({
        catalogo_url: DEFAULT_CATALOGO_URL,
        pedidos_url: pedidosUrl
    });
});

router.post('/config', (req, res) => {
    if (req.body.pedidos_url !== undefined) {
        pedidosUrl = req.body.pedidos_url;
    }
    res.json({ ok: true, catalogo_url: DEFAULT_CATALOGO_URL, pedidos_url: pedidosUrl });
});

router.post('/sync-catalogo', async (req, res, next) => {
    try {
        const url = req.body.url || DEFAULT_CATALOGO_URL;
        const resultado = await sincronizarCatalogo(url);
        res.json(resultado);
    } catch (err) {
        next(err);
    }
});

router.get('/pedidos-web', async (req, res, next) => {
    try {
        const url = req.query.url || pedidosUrl;
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

        const pedidosProcesados = rows.map(r => {
            // Normalizar claves ya que el CSV puede tener espacios en los encabezados (" Zona ", "Productos ")
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
            const total = parseFloat(normalizado.total) || 0;

            // Parsear ítems del string "Producto (1kg) x2 | Otro x1"
            const itemsParsed = productosStr.split('|').map(raw => {
                const trimmed = raw.trim();
                if (!trimmed) return null;
                const m = trimmed.match(/^(.*?)(?:\s*\((.*?)\))?\s*x(\d+(?:\.\d+)?)$/);
                const nombreItem = m ? m[1].trim() : trimmed;
                const unidadItem = m && m[2] ? m[2].trim() : 'kg';
                const cantidad = m ? parseFloat(m[3]) : 1;

                // Buscar producto más cercano en la DB
                const match = productosDB.find(p =>
                    p.nombre.toLowerCase() === nombreItem.toLowerCase() ||
                    p.nombre.toLowerCase().includes(nombreItem.toLowerCase()) ||
                    nombreItem.toLowerCase().includes(p.nombre.toLowerCase())
                );

                return {
                    raw: trimmed,
                    nombre: match ? match.nombre : nombreItem,
                    producto_id: match ? match.id : null,
                    unidad_medida: match ? match.unidad_medida : (unidadItem.includes('unidad') ? 'unidad' : 'kg'),
                    precio_unitario: match ? Number(match.precio_venta) : 0,
                    cantidad,
                    stock_actual: match ? Number(match.stock_actual) : 0
                };
            }).filter(Boolean);

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

        // Ordenar con los más recientes primero
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
                // Actualizar datos si no estaban
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
            const total = items.reduce((acc, it) => acc + (Number(it.cantidad || 0) * Number(it.precio_unitario || 0)), 0);
            const observaciones = req.body.observaciones || '';

            const { row: remitoRow } = await tx.run(
                `INSERT INTO remitos (numero, cliente_id, fecha, direccion_entrega, transportista, observaciones, total, usuario_id)
                 VALUES ($1, $2, CURRENT_DATE, $3, 'Distribución propia', $4, $5, $6) RETURNING id`,
                [numero, cliente.id, direccion_completa || null, observaciones, total, req.usuario.id]
            );

            const rId = remitoRow.id;

            // 3. Crear ítems y descontar stock por FEFO
            for (const it of items) {
                if (!it.producto_id) continue;
                const cant = Number(it.cantidad) || 1;
                const precio = Number(it.precio_unitario) || 0;

                const lotes = await tx.all(`
                    SELECT * FROM lotes WHERE producto_id = $1 AND cantidad_actual > 0
                    ORDER BY (fecha_vencimiento IS NULL), fecha_vencimiento ASC, fecha_ingreso ASC
                `, [it.producto_id]);

                let cantidadRestante = cant;
                let loteRef = null;
                for (const lote of lotes) {
                    if (cantidadRestante <= 0) break;
                    const tomar = Math.min(Number(lote.cantidad_actual), cantidadRestante);
                    await tx.run('UPDATE lotes SET cantidad_actual = cantidad_actual - $1 WHERE id = $2', [tomar, lote.id]);
                    cantidadRestante -= tomar;
                    if (!loteRef) loteRef = lote.id;
                }

                await tx.run(`
                    INSERT INTO remito_items (remito_id, producto_id, lote_id, cantidad, precio_unitario, subtotal)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [rId, it.producto_id, loteRef, cant, precio, cant * precio]);

                await tx.run('UPDATE productos SET stock_actual = stock_actual - $1 WHERE id = $2', [cant, it.producto_id]);

                await tx.run(`
                    INSERT INTO movimientos_stock (producto_id, lote_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
                    VALUES ($1, $2, 'egreso', $3, $4, 'remito', $5, $6)
                `, [it.producto_id, loteRef, cant, `Remito Web ${pedido_numero}`, rId, req.usuario.id]);
            }

            // Actualizar cuenta corriente del cliente si el remito tiene monto
            if (Number(total) > 0) {
                await tx.run('UPDATE clientes SET saldo_cuenta = saldo_cuenta + $1 WHERE id = $2', [total, cliente.id]);
                await tx.run(`
                    INSERT INTO movimientos_cuenta (entidad_tipo, entidad_id, tipo, monto, medio_pago, referencia_tipo, referencia_id, observaciones, usuario_id)
                    VALUES ('cliente', $1, 'cargo', $2, 'cuenta_corriente', 'remito', $3, $4, $5)
                `, [cliente.id, total, rId, `Remito Web ${pedido_numero} (${numero})`, req.usuario.id]);
            }

            return rId;
        });

        res.status(201).json(await db.one('SELECT * FROM remitos WHERE id = $1', [remitoId]));
    } catch (err) {
        next(err);
    }
});

module.exports = router;
