const express = require('express');
const db = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const RetencionService = require('../services/retencionService');

const router = express.Router();
router.use(requireAuth);

router.get('/resumen', async (req, res, next) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        const [carritosStats, reposStats, cuponesStats] = await Promise.all([
            db.one(`
                SELECT
                    COUNT(*) FILTER (WHERE estado = 'abandonado')::int AS abandonados,
                    COUNT(*) FILTER (WHERE estado = 'notificado')::int AS notificados,
                    COUNT(*) FILTER (WHERE estado = 'recuperado')::int AS recuperados,
                    COALESCE(SUM(total) FILTER (WHERE estado IN ('abandonado', 'notificado')), 0) AS monto_recuperable,
                    COALESCE(SUM(total) FILTER (WHERE estado = 'recuperado'), 0) AS monto_recuperado
                FROM carritos_abandonados
            `),
            db.one(`
                SELECT
                    COUNT(*) FILTER (WHERE estado = 'pendiente')::int AS pendientes,
                    COUNT(*) FILTER (WHERE estado = 'enviado')::int AS enviados,
                    COUNT(*) FILTER (WHERE estado = 'convertido')::int AS convertidos
                FROM recordatorios_reposicion
            `),
            db.one(`
                SELECT
                    COUNT(*) FILTER (WHERE activo = true AND valido_hasta > NOW() AND usos_actuales < usos_maximos)::int AS activos,
                    COUNT(*) FILTER (WHERE usos_actuales > 0)::int AS usados
                FROM cupones
            `)
        ]);

        res.json({
            carritos: carritosStats || { abandonados: 0, notificados: 0, recuperados: 0, monto_recuperable: 0, monto_recuperado: 0 },
            reposicion: reposStats || { pendientes: 0, enviados: 0, convertidos: 0 },
            cupones: cuponesStats || { activos: 0, usados: 0 }
        });
    } catch (err) {
        next(err);
    }
});

router.get('/carritos', async (req, res, next) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        const { estado } = req.query;
        const params = [];
        let where = `WHERE jsonb_array_length(ca.items) > 0 AND ca.estado <> 'expirado'`;

        if (estado && estado !== 'todos') {
            params.push(estado);
            where = `WHERE jsonb_array_length(ca.items) > 0 AND ca.estado = $${params.length}`;
        }

        const rows = await db.all(`
            SELECT ca.*,
                   EXTRACT(EPOCH FROM (NOW() - ca.ultima_actividad_at)) / 60 AS minutos_inactivo
            FROM carritos_abandonados ca
            ${where}
            ORDER BY
                CASE ca.estado
                    WHEN 'abandonado' THEN 1
                    WHEN 'notificado' THEN 2
                    WHEN 'activo' THEN 3
                    WHEN 'recuperado' THEN 4
                    ELSE 5
                END,
                ca.ultima_actividad_at DESC
        `, params);

        const carritos = rows.map(c => {
            const items = Array.isArray(c.items) ? c.items : [];
            const mensajeWhatsapp = RetencionService.buildMensajeCarrito({ ...c, items });
            const waUrl = RetencionService.buildWaUrl(c.telefono, mensajeWhatsapp);
            return {
                ...c,
                items,
                total: Number(c.total) || 0,
                minutos_inactivo: Math.max(0, Math.round(Number(c.minutos_inactivo) || 0)),
                mensaje_whatsapp: mensajeWhatsapp,
                wa_url: waUrl
            };
        });

        res.json({ carritos });
    } catch (err) {
        next(err);
    }
});

router.put('/carritos/:id/estado', async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        const { estado } = req.body;
        const validos = ['activo', 'abandonado', 'notificado', 'recuperado', 'expirado'];
        if (!validos.includes(estado)) {
            return res.status(400).json({ error: 'Estado de carrito inválido.' });
        }

        const { row } = await db.run(`
            UPDATE carritos_abandonados
            SET estado = $1::text,
                notificado_at = CASE WHEN $1::text = 'notificado' THEN COALESCE(notificado_at, NOW()) ELSE notificado_at END,
                recuperado_at = CASE WHEN $1::text = 'recuperado' THEN COALESCE(recuperado_at, NOW()) ELSE recuperado_at END,
                updated_at = NOW()
            WHERE id = $2
            RETURNING *
        `, [estado, id]);

        if (!row) return res.status(404).json({ error: 'Carrito no encontrado.' });
        res.json({ ok: true, carrito: row });
    } catch (err) {
        next(err);
    }
});

router.get('/reposicion', async (req, res, next) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        const { estado } = req.query;
        const params = [];
        let where = '';
        if (estado && estado !== 'todos') {
            params.push(estado);
            where = `WHERE rr.estado = $1`;
        }

        const rows = await db.all(`
            SELECT rr.*,
                   c.razon_social AS cliente_nombre,
                   c.telefono AS cliente_telefono,
                   c.localidad AS cliente_localidad,
                   r.numero AS remito_numero,
                   r.fecha AS remito_fecha,
                   r.total AS remito_total,
                   (CURRENT_DATE - r.fecha::date)::int AS dias_desde_compra,
                   cu.codigo AS cupon_codigo,
                   cu.tipo_descuento AS cupon_tipo,
                   cu.valor_descuento AS cupon_valor,
                   cu.valido_hasta AS cupon_valido_hasta,
                   cu.activo AS cupon_activo,
                   cu.usos_actuales AS cupon_usos,
                   cu.usos_maximos AS cupon_usos_maximos
            FROM recordatorios_reposicion rr
            JOIN clientes c ON c.id = rr.cliente_id
            JOIN remitos r ON r.id = rr.remito_id
            LEFT JOIN cupones cu ON cu.id = rr.cupon_id
            ${where}
            ORDER BY
                CASE rr.estado
                    WHEN 'pendiente' THEN 1
                    WHEN 'enviado' THEN 2
                    WHEN 'convertido' THEN 3
                    ELSE 4
                END,
                r.fecha ASC
        `, params);

        const remitoIds = Array.from(new Set(rows.map(r => r.remito_id).filter(Boolean)));
        const itemsMap = {};
        if (remitoIds.length > 0) {
            const itemsRows = await db.all(`
                SELECT ri.remito_id, p.nombre, ri.cantidad, p.unidad_medida, ri.descripcion
                FROM remito_items ri
                JOIN productos p ON p.id = ri.producto_id
                WHERE ri.remito_id = ANY($1::int[])
                ORDER BY ri.id ASC
            `, [remitoIds]);

            for (const it of itemsRows) {
                if (!itemsMap[it.remito_id]) itemsMap[it.remito_id] = [];
                itemsMap[it.remito_id].push(it);
            }
        }

        const recordatorios = rows.map(r => ({
            ...r,
            remito_total: Number(r.remito_total) || 0,
            cupon_valor: r.cupon_valor !== null ? Number(r.cupon_valor) : null,
            items: itemsMap[r.remito_id] || []
        }));

        res.json({ recordatorios });
    } catch (err) {
        next(err);
    }
});

router.post('/reposicion/:id/preparar-envio', async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        const { con_cupon = false, porcentaje = 10, dias_validez = 7 } = req.body || {};
        const result = await RetencionService.prepararEnvioReposicion(id, { con_cupon, porcentaje, dias_validez });
        res.json(result);
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

router.put('/reposicion/:id/estado', async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        const { estado } = req.body;
        const validos = ['pendiente', 'enviado', 'convertido', 'descartado'];
        if (!validos.includes(estado)) {
            return res.status(400).json({ error: 'Estado de recordatorio inválido.' });
        }

        const { row } = await db.run(`
            UPDATE recordatorios_reposicion
            SET estado = $1::text,
                convertido_at = CASE WHEN $1::text = 'convertido' THEN COALESCE(convertido_at, NOW()) ELSE convertido_at END
            WHERE id = $2
            RETURNING *
        `, [estado, id]);

        if (!row) return res.status(404).json({ error: 'Recordatorio no encontrado.' });
        res.json({ ok: true, recordatorio: row });
    } catch (err) {
        next(err);
    }
});

router.get('/cupones', async (req, res, next) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        const cupones = await db.all(`
            SELECT cu.*,
                   c.razon_social AS cliente_nombre,
                   r.numero AS remito_numero,
                   pw.numero AS pedido_web_numero
            FROM cupones cu
            LEFT JOIN clientes c ON c.id = cu.cliente_id
            LEFT JOIN remitos r ON r.id = cu.remito_origen_id
            LEFT JOIN pedidos_web pw ON pw.id = cu.usado_en_pedido_id
            ORDER BY cu.created_at DESC
        `);
        res.json({ cupones });
    } catch (err) {
        next(err);
    }
});

router.post('/cupones', async (req, res, next) => {
    try {
        const {
            codigo,
            tipo_descuento = 'porcentaje',
            valor_descuento = 10,
            usos_maximos = 1,
            dias_validez = 7,
            cliente_id = null,
            telefono_cliente = null
        } = req.body || {};

        const val = Number(valor_descuento);
        if (!val || val <= 0) {
            return res.status(400).json({ error: 'El valor de descuento debe ser mayor a 0.' });
        }
        if (tipo_descuento === 'porcentaje' && val > 90) {
            return res.status(400).json({ error: 'El porcentaje no puede superar el 90%.' });
        }

        const codigoFinal = String(codigo || '').trim().toUpperCase() || RetencionService.generarCodigoCupon('MIX');
        const existe = await db.one('SELECT id FROM cupones WHERE UPPER(codigo) = UPPER($1)', [codigoFinal]);
        if (existe) {
            return res.status(409).json({ error: `Ya existe un cupón con código ${codigoFinal}.` });
        }

        const dias = Math.max(1, parseInt(dias_validez, 10) || 7);
        const usosMax = Math.max(1, parseInt(usos_maximos, 10) || 1);

        const { row } = await db.run(`
            INSERT INTO cupones (
                codigo, tipo_descuento, valor_descuento, cliente_id, telefono_cliente, usos_maximos, valido_hasta, activo
            )
            VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7::int * INTERVAL '1 day'), true)
            RETURNING *
        `, [codigoFinal, tipo_descuento, val, cliente_id || null, telefono_cliente || null, usosMax, dias]);

        res.status(201).json({ ok: true, cupon: row });
    } catch (err) {
        next(err);
    }
});

router.put('/cupones/:id/toggle', async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        const { row } = await db.run(`
            UPDATE cupones SET activo = NOT activo WHERE id = $1 RETURNING *
        `, [id]);
        if (!row) return res.status(404).json({ error: 'Cupón no encontrado.' });
        res.json({ ok: true, cupon: row });
    } catch (err) {
        next(err);
    }
});

router.post('/cron/carritos-abandonados', async (req, res, next) => {
    try {
        const result = await RetencionService.detectarCarritosAbandonados();
        res.json({ ok: true, ...result });
    } catch (err) {
        next(err);
    }
});

router.post('/cron/reposicion', async (req, res, next) => {
    try {
        const result = await RetencionService.detectarClientesReposicion();
        res.json({ ok: true, ...result });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
