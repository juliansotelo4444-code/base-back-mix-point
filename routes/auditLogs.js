const express = require('express');
const db = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/**
 * GET /api/audit-logs
 * Obtiene el historial de actividad paginado y con filtros
 */
router.get('/', async (req, res, next) => {
    try {
        const {
            pagina = 1,
            limite = 20,
            usuario_id,
            entidad,
            accion,
            desde,
            hasta,
            q
        } = req.query;

        const limitNum = Math.max(1, Math.min(100, parseInt(limite, 10) || 20));
        const pageNum = Math.max(1, parseInt(pagina, 10) || 1);
        const offset = (pageNum - 1) * limitNum;

        let whereClause = 'WHERE 1=1';
        const params = [];

        if (usuario_id) {
            params.push(parseInt(usuario_id, 10));
            whereClause += ` AND a.usuario_id = $${params.length}`;
        }

        if (entidad) {
            params.push(entidad.toLowerCase().trim());
            whereClause += ` AND a.entidad = $${params.length}`;
        }

        if (accion) {
            params.push(accion.toUpperCase().trim());
            whereClause += ` AND a.accion = $${params.length}`;
        }

        if (desde) {
            params.push(desde);
            whereClause += ` AND a.created_at >= $${params.length}::timestamptz`;
        }

        if (hasta) {
            params.push(hasta + ' 23:59:59');
            whereClause += ` AND a.created_at <= $${params.length}::timestamptz`;
        }

        if (q) {
            params.push(`%${q}%`);
            whereClause += ` AND (
                a.accion ILIKE $${params.length} OR 
                a.entidad ILIKE $${params.length} OR 
                u.nombre ILIKE $${params.length} OR 
                a.detalles::text ILIKE $${params.length}
            )`;
        }

        // Conteo total para paginación
        const countSql = `
            SELECT COUNT(*) as total
            FROM audit_logs a
            LEFT JOIN usuarios u ON u.id = a.usuario_id
            ${whereClause}
        `;
        const countRes = await db.one(countSql, params);
        const total = parseInt(countRes?.total || 0, 10);
        const totalPaginas = Math.ceil(total / limitNum);

        // Consulta de datos
        const dataSql = `
            SELECT 
                a.id,
                a.usuario_id,
                u.nombre as usuario_nombre,
                u.email as usuario_email,
                u.rol as usuario_rol,
                a.accion,
                a.entidad,
                a.entidad_id,
                a.detalles,
                a.ip_origen,
                a.created_at
            FROM audit_logs a
            LEFT JOIN usuarios u ON u.id = a.usuario_id
            ${whereClause}
            ORDER BY a.created_at DESC, a.id DESC
            LIMIT ${limitNum} OFFSET ${offset}
        `;
        const logs = await db.all(dataSql, params);

        res.json({
            logs,
            paginacion: {
                total,
                pagina: pageNum,
                limite: limitNum,
                totalPaginas
            }
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
