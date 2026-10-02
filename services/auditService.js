const db = require('../db/pool');

/**
 * Servicio Central de Historial de Actividad (Audit Logs)
 */
class AuditService {
    /**
     * Registra un evento en la tabla audit_logs
     * @param {Object} data
     * @param {number|null} data.usuario_id ID del usuario autenticado
     * @param {string} data.accion Ej: 'CREO_REMITO', 'EDITO_REMITO', 'ASIGNO_PEDIDO', 'CAMBIO_ESTADO'
     * @param {string} data.entidad Ej: 'remitos', 'productos', 'clientes'
     * @param {number|string|null} data.entidad_id ID de la entidad
     * @param {Object} data.detalles Objeto con info { antes, despues, diff, items, motivo, etc. }
     * @param {string|null} data.ip_origen Dirección IP del cliente
     * @param {Object|null} clientOrTx Cliente de transacción opcional de db.transaction
     */
    static async registrar({
        usuario_id = null,
        accion,
        entidad,
        entidad_id = null,
        detalles = {},
        ip_origen = null
    }, clientOrTx = null) {
        if (!accion || !entidad) {
            console.warn('[AuditService] Faltan parámetros obligatorios (accion, entidad).');
            return null;
        }

        const runner = clientOrTx || db;
        const sql = `
            INSERT INTO audit_logs (usuario_id, accion, entidad, entidad_id, detalles, ip_origen, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
            RETURNING id, created_at;
        `;
        const values = [
            usuario_id ? Number(usuario_id) : null,
            String(accion).toUpperCase().trim(),
            String(entidad).toLowerCase().trim(),
            entidad_id ? Number(entidad_id) : null,
            JSON.stringify(detalles || {}),
            ip_origen ? String(ip_origen).slice(0, 45) : null
        ];

        try {
            if (clientOrTx && typeof clientOrTx.run === 'function') {
                const res = await clientOrTx.run(sql, values);
                return res.row;
            } else {
                const res = await runner.one(sql, values);
                return res;
            }
        } catch (err) {
            console.error('[AuditService] Error registrando auditoría:', err.message);
            // Si está dentro de una transacción ACID, relanzar para permitir rollback
            if (clientOrTx) {
                throw err;
            }
            return null;
        }
    }

    /**
     * Helper para extraer la IP cliente de Express
     */
    static extraerIp(req) {
        if (!req) return null;
        const forwarded = req.headers['x-forwarded-for'];
        if (forwarded) {
            return forwarded.split(',')[0].trim();
        }
        return req.ip || req.connection?.remoteAddress || null;
    }
}

module.exports = AuditService;
