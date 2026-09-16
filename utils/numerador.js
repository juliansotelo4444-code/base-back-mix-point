const db = require('../db/pool');

/**
 * Genera un número correlativo tipo PREFIJO-000123 para una tabla dada.
 * Ej: await generarNumero('remitos', 'REM') -> 'REM-000001'
 * Acepta opcionalmente un cliente de transacción (para que el conteo sea consistente
 * dentro de la misma transacción que hace el INSERT).
 */
async function generarNumero(tabla, prefijo, cliente = db) {
    // Extrae el número más alto existente para evitar duplicados si hay registros borrados o desfasados
    const row = await cliente.one(`
        SELECT COALESCE(MAX(NULLIF(regexp_replace(numero, '[^0-9]', '', 'g'), '')::bigint), 0) as max_num
        FROM ${tabla}
    `);
    const siguiente = Number(row?.max_num || 0) + 1;
    return `${prefijo}-${String(siguiente).padStart(6, '0')}`;
}

module.exports = { generarNumero };
