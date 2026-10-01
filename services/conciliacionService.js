const db = require('../db/pool');
const { sanitizarNumero, parseCSVLine } = require('./googleSheets');
const AlertasService = require('./alertasService');

/**
 * Servicio de Conciliación Bancaria y Billeteras Virtuales (Mercado Pago, Bancos)
 */
class ConciliacionService {
    /**
     * Parsea un archivo CSV o texto tabulado de extracto bancario / Mercado Pago
     */
    static parsearExtracto(contenido, formato = 'auto') {
        const lineas = contenido.split(/\r?\n/).filter(l => l.trim().length > 0);
        if (lineas.length < 2) return [];

        // Detectar separador (; o , o \t)
        const primeraLinea = lineas[0];
        let sep = ',';
        if (primeraLinea.includes(';') && (primeraLinea.split(';').length > primeraLinea.split(',').length)) {
            sep = ';';
        } else if (primeraLinea.includes('\t') && (primeraLinea.split('\t').length > primeraLinea.split(',').length)) {
            sep = '\t';
        }

        const headers = (sep === ',' ? parseCSVLine(lineas[0]) : lineas[0].split(sep)).map(h => h.trim().toLowerCase().replace(/"/g, ''));
        const movimientos = [];

        // Detectar columnas clave
        const colFecha = headers.findIndex(h => h.includes('fecha') || h.includes('date'));
        const colMonto = headers.findIndex(h => h.includes('monto') || h.includes('importe') || h.includes('credito') || h.includes('neto') || h.includes('amount'));
        const colDesc = headers.findIndex(h => h.includes('descrip') || h.includes('concepto') || h.includes('motivo') || h.includes('detalle'));
        const colComp = headers.findIndex(h => h.includes('comprobante') || h.includes('operacion') || h.includes('id') || h.includes('referencia'));
        const colTitular = headers.findIndex(h => h.includes('titular') || h.includes('nombre') || h.includes('contraparte') || h.includes('remitente'));
        const colCuit = headers.findIndex(h => h.includes('cuit') || h.includes('cuil') || h.includes('documento') || h.includes('dni'));

        for (let i = 1; i < lineas.length; i++) {
            const rawCols = (sep === ',' ? parseCSVLine(lineas[i]) : lineas[i].split(sep)).map(c => c.trim().replace(/^["']|["']$/g, ''));
            if (rawCols.length < 2) continue;

            const montoRaw = colMonto !== -1 ? rawCols[colMonto] : '';
            const monto = sanitizarNumero(montoRaw);
            // Solo conciliar ingresos / créditos mayores a 0
            if (monto <= 0) continue;

            let fecha = colFecha !== -1 ? rawCols[colFecha] : '';
            // Normalizar fecha DD/MM/AAAA a AAAA-MM-DD
            if (fecha.includes('/')) {
                const parts = fecha.split(' ')[0].split('/');
                if (parts.length === 3) {
                    if (parts[2].length === 4) {
                        fecha = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
                    } else if (parts[0].length === 4) {
                        fecha = `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
                    }
                }
            } else if (!fecha) {
                fecha = new Date().toISOString().slice(0, 10);
            }

            movimientos.push({
                fecha_movimiento: fecha.slice(0, 10),
                monto,
                descripcion: colDesc !== -1 ? rawCols[colDesc] : '',
                comprobante_nro: colComp !== -1 ? rawCols[colComp] : '',
                titular: colTitular !== -1 ? rawCols[colTitular] : '',
                cuit: colCuit !== -1 ? rawCols[colCuit] : ''
            });
        }

        return movimientos;
    }

    /**
     * Importa movimientos a la tabla conciliaciones_bancarias y calcula coincidencias automáticas
     */
    static async importarYCruzar(movimientos, cuentaOrigen = 'mercadopago') {
        // Cargar clientes con saldos deudores y remitos recientes
        const clientes = await db.all('SELECT id, razon_social, cuit, saldo_cuenta FROM clientes');
        const remitosPendientes = await db.all(`
            SELECT r.id, r.numero, r.total, r.fecha, r.cliente_id, c.razon_social as cliente_nombre
            FROM remitos r
            JOIN clientes c ON c.id = r.cliente_id
            WHERE r.fecha >= CURRENT_DATE - INTERVAL '60 days'
            ORDER BY r.fecha DESC
        `);

        const insertados = [];

        for (const mov of movimientos) {
            // Verificar si el comprobante ya fue importado
            if (mov.comprobante_nro) {
                const existe = await db.one('SELECT id FROM conciliaciones_bancarias WHERE comprobante_nro = $1 AND cuenta_origen = $2', [mov.comprobante_nro, cuentaOrigen]);
                if (existe) continue;
            }

            // Algoritmo de Coincidencia Inteligente
            let remitoSugerido = null;
            let clienteSugerido = null;
            let confianza = 0; // 0 a 100
            let observaciones = '';

            const textoBusqueda = `${mov.descripcion || ''} ${mov.titular || ''} ${mov.comprobante_nro || ''}`.toLowerCase();

            // 1. Coincidencia por Número de Remito en comprobante o descripción
            const remitoPorTexto = remitosPendientes.find(r => 
                textoBusqueda.includes(r.numero.toLowerCase()) || 
                (r.numero.replace(/\D/g, '') && textoBusqueda.includes(r.numero.replace(/\D/g, '')))
            );

            if (remitoPorTexto) {
                remitoSugerido = remitoPorTexto;
                clienteSugerido = clientes.find(c => c.id === remitoPorTexto.cliente_id);
                confianza = 95;
                observaciones = `Coincidencia directa por nro de remito: ${remitoPorTexto.numero}`;
            } else {
                // 2. Coincidencia por Monto Exacto con Remito
                const remitoPorMonto = remitosPendientes.find(r => Math.abs(Number(r.total) - mov.monto) < 1.00);

                // 3. Coincidencia por Nombre de Cliente
                let clientePorNombre = null;
                for (const c of clientes) {
                    const palabras = c.razon_social.toLowerCase().split(' ').filter(w => w.length > 3);
                    const match = palabras.some(p => textoBusqueda.includes(p));
                    if (match) {
                        clientePorNombre = c;
                        break;
                    }
                }

                if (remitoPorMonto && clientePorNombre && remitoPorMonto.cliente_id === clientePorNombre.id) {
                    remitoSugerido = remitoPorMonto;
                    clienteSugerido = clientePorNombre;
                    confianza = 90;
                    observaciones = 'Coincidencia exacta de monto y nombre de cliente.';
                } else if (remitoPorMonto) {
                    remitoSugerido = remitoPorMonto;
                    clienteSugerido = clientes.find(c => c.id === remitoPorMonto.cliente_id);
                    confianza = 75;
                    observaciones = `Monto exacto ($${mov.monto}) coincide con remito ${remitoPorMonto.numero} de ${remitoPorMonto.cliente_nombre}.`;
                } else if (clientePorNombre) {
                    clienteSugerido = clientePorNombre;
                    confianza = 60;
                    observaciones = `Identificado cliente ${clientePorNombre.razon_social} por nombre en la transferencia.`;
                }
            }

            const estado = 'pendiente';
            const diferencia = remitoSugerido ? (mov.monto - Number(remitoSugerido.total)) : 0;

            const { row } = await db.run(`
                INSERT INTO conciliaciones_bancarias (
                    fecha_movimiento, cuenta_origen, descripcion, monto, comprobante_nro,
                    titular, cuit, remito_id, cliente_id, estado, diferencia, observaciones
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                RETURNING *
            `, [
                mov.fecha_movimiento,
                cuentaOrigen,
                mov.descripcion || null,
                mov.monto,
                mov.comprobante_nro || null,
                mov.titular || null,
                mov.cuit || null,
                remitoSugerido ? remitoSugerido.id : null,
                clienteSugerido ? clienteSugerido.id : null,
                estado,
                diferencia,
                observaciones || null
            ]);

            insertados.push({ ...row, confianza });
        }

        return {
            total_procesados: movimientos.length,
            importados: insertados.length,
            items: insertados
        };
    }

    /**
     * Confirma la conciliación de un movimiento:
     * - Acredita el pago a la cuenta corriente del cliente
     * - Cambia el estado de la conciliación a 'conciliado'
     */
    static async conciliar({ conciliacion_id, cliente_id, remito_id, observaciones, usuario_id }) {
        return await db.transaction(async (tx) => {
            const mov = await tx.one('SELECT * FROM conciliaciones_bancarias WHERE id = $1', [conciliacion_id]);
            if (!mov) throw new Error('Movimiento de conciliación no encontrado.');
            if (mov.estado === 'conciliado') throw new Error('Este movimiento ya se encuentra conciliado.');

            const cId = cliente_id || mov.cliente_id;
            const rId = remito_id || mov.remito_id;

            if (!cId) throw new Error('Debe especificar un cliente para imputar el pago.');

            const monto = Number(mov.monto);

            // 1. Descontar saldo deudor del cliente
            await tx.run('UPDATE clientes SET saldo_cuenta = saldo_cuenta - $1 WHERE id = $2', [monto, cId]);

            // 2. Registrar movimiento de crédito/pago en cuenta corriente
            const obs = observaciones || `Conciliación bancaria ${mov.cuenta_origen.toUpperCase()} (Comprobante: ${mov.comprobante_nro || 'S/N'})`;
            await tx.run(`
                INSERT INTO movimientos_cuenta (
                    entidad_tipo, entidad_id, tipo, monto, medio_pago,
                    referencia_tipo, referencia_id, observaciones, usuario_id
                ) VALUES ('cliente', $1, 'cobro', $2, $3, 'conciliacion', $4, $5, $6)
            `, [cId, monto, mov.cuenta_origen, mov.id, obs, usuario_id || null]);

            // 3. Actualizar registro de conciliación
            const { row } = await tx.run(`
                UPDATE conciliaciones_bancarias SET
                    estado = 'conciliado',
                    cliente_id = $1,
                    remito_id = $2,
                    observaciones = $3
                WHERE id = $4
                RETURNING *
            `, [cId, rId, obs, conciliacion_id]);

            return row;
        });
    }

    /**
     * Descarta un movimiento (por ejemplo un retiro de fondos o cargo interno que no corresponde a clientes)
     */
    static async descartar(conciliacionId, motivo = '') {
        const { row } = await db.run(`
            UPDATE conciliaciones_bancarias SET
                estado = 'descartado',
                observaciones = COALESCE($1, observaciones)
            WHERE id = $2
            RETURNING *
        `, [motivo || 'Descartado manualmente', conciliacionId]);
        return row;
    }
}

module.exports = ConciliacionService;
