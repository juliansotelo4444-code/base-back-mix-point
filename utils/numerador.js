const db = require('../db/pool');

/**
 * Genera un número correlativo tipo PREFIJO-000123 para una tabla dada.
 * Ej: await generarNumero('remitos', 'REM') -> 'REM-000001'
 * Acepta opcionalmente un cliente de transacción (para que el conteo sea consistente
 * dentro de la misma transacción que hace el INSERT).
 */
async function generarNumero(tabla, prefijo, cliente = db) {
    const row = await cliente.one(`SELECT COUNT(*)::int as c FROM ${tabla}`);
    const siguiente = (row?.c || 0) + 1;
    return `${prefijo}-${String(siguiente).padStart(6, '0')}`;
}

module.exports = { generarNumero };
