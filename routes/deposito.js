const express = require('express');
const db = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const AuditService = require('../services/auditService');
const { emitirEventoDeposito } = require('../socket');
const WebhookService = require('../services/webhookService');

const router = express.Router();
router.use(requireAuth);

/**
 * GET /api/deposito/kanban
 * Devuelve los pedidos divididos en las 3 columnas de depósito:
 * - pendiente (pedidos sin iniciar)
 * - armando (en preparación en mesa de picking)
 * - listo (listo para despacho o en camino)
 */
router.get('/kanban', async (req, res, next) => {
    try {
        const sql = `
            SELECT 
                r.id,
                r.numero,
                r.fecha,
                r.estado,
                r.total,
                r.bultos,
                r.peso_kg,
                r.transportista,
                r.direccion_entrega,
                r.observaciones,
                r.operario_asignado_id,
                r.created_at,
                c.id as cliente_id,
                c.razon_social as cliente_nombre,
                c.telefono as cliente_telefono,
                c.localidad as cliente_localidad,
                u.nombre as operario_nombre,
                u.email as operario_email,
                (SELECT COUNT(*) FROM remito_items ri WHERE ri.remito_id = r.id) as items_cantidad,
                (SELECT COALESCE(SUM(ri.cantidad), 0) FROM remito_items ri WHERE ri.remito_id = r.id) as total_unidades
            FROM remitos r
            JOIN clientes c ON c.id = r.cliente_id
            LEFT JOIN usuarios u ON u.id = r.operario_asignado_id
            WHERE r.estado NOT IN ('facturado', 'cancelado', 'anulado')
            ORDER BY r.fecha ASC, r.id ASC
        `;

        const pedidos = await db.all(sql);

        // Agrupar en las 3 columnas Kanban
        const columnas = {
            pendiente: [],
            armando: [],
            listo: []
        };

        for (const p of pedidos) {
            if (p.estado === 'en_preparacion' || (p.operario_asignado_id && p.estado !== 'en_camino' && p.estado !== 'entregado')) {
                columnas.armando.push(p);
            } else if (p.estado === 'en_camino' || p.estado === 'entregado') {
                columnas.listo.push(p);
            } else {
                columnas.pendiente.push(p);
            }
        }

        res.json({
            columnas,
            totales: {
                pendiente: columnas.pendiente.length,
                armando: columnas.armando.length,
                listo: columnas.listo.length,
                total: pedidos.length
            }
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/deposito/remitos/:id/tomar
 * Control de concurrencia atómica estricta (Evita colisiones entre operarios)
 */
router.post('/remitos/:id/tomar', async (req, res, next) => {
    try {
        const remitoId = parseInt(req.params.id, 10);
        const operarioId = req.usuario.id;
        const ip = AuditService.extraerIp(req);

        // Intentar actualizar atómicamente solo si está libre o ya asignado al mismo operario
        const resultado = await db.query(`
            UPDATE remitos
            SET operario_asignado_id = $1, estado = 'en_preparacion'
            WHERE id = $2 AND (operario_asignado_id IS NULL OR operario_asignado_id = $1)
            RETURNING *;
        `, [operarioId, remitoId]);

        if (!resultado.rows || resultado.rows.length === 0) {
            // Conflicto: Ya fue tomado por otro operario
            const actual = await db.one(`
                SELECT r.id, r.numero, r.operario_asignado_id, u.nombre as operario_nombre
                FROM remitos r
                LEFT JOIN usuarios u ON u.id = r.operario_asignado_id
                WHERE r.id = $1
            `, [remitoId]);

            return res.status(409).json({
                error: `El pedido #${actual?.numero || remitoId} ya fue tomado por ${actual?.operario_nombre || 'otro operario'}.`,
                operario_actual: actual?.operario_nombre || 'Otro usuario'
            });
        }

        const remitoActualizado = resultado.rows[0];

        // Registrar en auditoría
        await AuditService.registrar({
            usuario_id: operarioId,
            accion: 'TOMO_PEDIDO_DEPOSITO',
            entidad: 'remitos',
            entidad_id: remitoId,
            detalles: {
                numero: remitoActualizado.numero,
                operario_id: operarioId,
                operario_nombre: req.usuario.nombre
            },
            ip_origen: ip
        });

        // Emitir evento en tiempo real a todos los clientes del depósito
        emitirEventoDeposito('remito:asignado', {
            remito_id: remitoId,
            numero: remitoActualizado.numero,
            operario_id: operarioId,
            operario_nombre: req.usuario.nombre,
            nuevo_estado: 'en_preparacion'
        });

        res.json({
            ok: true,
            mensaje: 'Pedido tomado con éxito.',
            remito: remitoActualizado
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/deposito/remitos/:id/liberar
 * Libera un pedido para que otro operario pueda tomarlo
 */
router.post('/remitos/:id/liberar', async (req, res, next) => {
    try {
        const remitoId = parseInt(req.params.id, 10);
        const operarioId = req.usuario.id;
        const ip = AuditService.extraerIp(req);

        // Operarios pueden liberar sus propios pedidos; admins pueden liberar cualquiera
        const condicion = req.usuario.rol === 'admin'
            ? 'id = $1'
            : 'id = $1 AND (operario_asignado_id = $2 OR operario_asignado_id IS NULL)';

        const params = req.usuario.rol === 'admin' ? [remitoId] : [remitoId, operarioId];

        const resultado = await db.query(`
            UPDATE remitos
            SET operario_asignado_id = NULL, estado = 'pendiente'
            WHERE ${condicion}
            RETURNING *;
        `, params);

        if (!resultado.rows || resultado.rows.length === 0) {
            return res.status(403).json({ error: 'No tenés permisos para liberar este pedido.' });
        }

        const remitoActualizado = resultado.rows[0];

        await AuditService.registrar({
            usuario_id: operarioId,
            accion: 'LIBERO_PEDIDO_DEPOSITO',
            entidad: 'remitos',
            entidad_id: remitoId,
            detalles: {
                numero: remitoActualizado.numero,
                liberado_por: req.usuario.nombre
            },
            ip_origen: ip
        });

        emitirEventoDeposito('remito:liberado', {
            remito_id: remitoId,
            numero: remitoActualizado.numero,
            nuevo_estado: 'pendiente'
        });

        res.json({ ok: true, mensaje: 'Pedido liberado al depósito.' });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/deposito/remitos/:id/mover-columna
 * Permite el Drag & Drop directo entre columnas Kanban
 */
router.put('/remitos/:id/mover-columna', async (req, res, next) => {
    try {
        const remitoId = parseInt(req.params.id, 10);
        const { destino } = req.body; // 'pendiente' | 'armando' | 'listo'
        const ip = AuditService.extraerIp(req);

        const remito = await db.one('SELECT * FROM remitos WHERE id = $1', [remitoId]);
        if (!remito) return res.status(404).json({ error: 'Remito no encontrado.' });

        let nuevoEstado = remito.estado;
        let nuevoOperario = remito.operario_asignado_id;

        if (destino === 'pendiente') {
            nuevoEstado = 'pendiente';
            nuevoOperario = null;
        } else if (destino === 'armando') {
            nuevoEstado = 'en_preparacion';
            nuevoOperario = req.usuario.id;
        } else if (destino === 'listo') {
            nuevoEstado = 'en_camino';
        } else {
            return res.status(400).json({ error: 'Destino Kanban inválido.' });
        }

        await db.run(`
            UPDATE remitos
            SET estado = $1, operario_asignado_id = $2
            WHERE id = $3
        `, [nuevoEstado, nuevoOperario, remitoId]);

        await AuditService.registrar({
            usuario_id: req.usuario.id,
            accion: 'MOVER_ESTADO_KANBAN',
            entidad: 'remitos',
            entidad_id: remitoId,
            detalles: {
                numero: remito.numero,
                antes: { estado: remito.estado, operario: remito.operario_asignado_id },
                despues: { estado: nuevoEstado, operario: nuevoOperario, columna: destino }
            },
            ip_origen: ip
        });

        emitirEventoDeposito('kanban:movido', {
            remito_id: remitoId,
            numero: remito.numero,
            columna_destino: destino,
            nuevo_estado: nuevoEstado,
            operario_asignado_id: nuevoOperario,
            operario_nombre: nuevoOperario ? req.usuario.nombre : null
        });

        // Webhook opcional si pasa a listo
        if (destino === 'listo') {
            WebhookService.notificarCambioRemito({ ...remito, estado: nuevoEstado }, 'LISTO_DESPACHO').catch(() => {});
        }

        res.json({ ok: true, mensaje: `Pedido movido a ${destino}.` });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/deposito/batch/cambiar-estado
 * Modificación en lote (Batching) para múltiples pedidos seleccionados
 */
router.post('/batch/cambiar-estado', async (req, res, next) => {
    try {
        const { remito_ids, destino } = req.body;
        if (!remito_ids || !Array.isArray(remito_ids) || !remito_ids.length) {
            return res.status(400).json({ error: 'Debe seleccionar al menos un pedido.' });
        }

        const ids = remito_ids.map(Number).filter(Boolean);
        const ip = AuditService.extraerIp(req);

        let nuevoEstado = 'en_preparacion';
        let nuevoOperario = req.usuario.id;

        if (destino === 'pendiente') {
            nuevoEstado = 'pendiente';
            nuevoOperario = null;
        } else if (destino === 'armando') {
            nuevoEstado = 'en_preparacion';
            nuevoOperario = req.usuario.id;
        } else if (destino === 'listo') {
            nuevoEstado = 'en_camino';
        }

        await db.run(`
            UPDATE remitos
            SET estado = $1, operario_asignado_id = $2
            WHERE id = ANY($3::int[])
        `, [nuevoEstado, nuevoOperario, ids]);

        await AuditService.registrar({
            usuario_id: req.usuario.id,
            accion: 'BATCH_CAMBIO_ESTADO_DEPOSITO',
            entidad: 'remitos',
            detalles: {
                remito_ids: ids,
                destino,
                nuevo_estado: nuevoEstado
            },
            ip_origen: ip
        });

        emitirEventoDeposito('kanban:batch_actualizado', {
            remito_ids: ids,
            destino,
            nuevo_estado: nuevoEstado,
            operario_nombre: nuevoOperario ? req.usuario.nombre : null
        });

        res.json({ ok: true, mensaje: `${ids.length} pedidos actualizados a ${destino}.` });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
