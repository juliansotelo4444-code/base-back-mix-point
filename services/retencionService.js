const crypto = require('crypto');
const db = require('../db/pool');
const WebhookService = require('./webhookService');
const { emitirEventoDeposito } = require('../socket');

const STORE_URL = (process.env.STORE_URL || 'https://mix-point.vercel.app').replace(/\/+$/, '');
const CUPON_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function normalizarTelefonoWhatsApp(tel) {
    let digits = String(tel || '').replace(/\D/g, '');
    if (digits.length < 8) return '';
    if (digits.startsWith('0')) digits = digits.slice(1);
    if (digits.startsWith('15')) digits = '11' + digits.slice(2);
    if (digits.startsWith('54') && !digits.startsWith('549') && digits.length >= 11) {
        digits = '549' + digits.slice(2);
    }
    if (!digits.startsWith('549') && digits.length >= 10) {
        digits = '549' + digits;
    }
    return digits;
}

function generarCodigoCupon(prefijo = 'REPONER') {
    let suffix = '';
    const bytes = crypto.randomBytes(4);
    for (let i = 0; i < 4; i++) {
        suffix += CUPON_CHARS[bytes[i] % CUPON_CHARS.length];
    }
    return `${String(prefijo || 'MIX').toUpperCase().replace(/[^A-Z0-9]/g, '')}-${suffix}`;
}

function buildMensajeCarrito(carrito) {
    const items = Array.isArray(carrito.items) ? carrito.items : [];
    const lineas = items.slice(0, 6).map(it => {
        const escala = it.escala || it.escalaSeleccionada || it.unidad_medida || '';
        const cant = it.cantidad || it.quantity || 1;
        return `• ${it.nombre}${escala ? ` (${escala})` : ''} x${cant}`;
    });
    if (items.length > 6) {
        lineas.push(`• ...y ${items.length - 6} producto(s) más`);
    }

    const totalFmt = Math.round(Number(carrito.total) || 0).toLocaleString('es-AR');
    const saludo = carrito.cliente_nombre ? `¡Hola ${carrito.cliente_nombre}!` : '¡Hola!';

    return (
        `${saludo} Te escribimos de *Distribuidora Mix Point* 🌰\n\n` +
        `Vimos que estuviste armando un pedido en nuestra tienda y te quedó pendiente de confirmar:\n` +
        `${lineas.join('\n')}\n\n` +
        `💰 Total estimado: *$${totalFmt}*\n\n` +
        `¿Querés que te lo confirmemos o te ayudamos a modificar algo? Podés retomarlo acá:\n` +
        `${STORE_URL}/catalogo`
    );
}

function buildMensajeReposicion({ clienteNombre, productosResumen, enlace, conCupon, cupon }) {
    const saludo = clienteNombre ? `¡Hola ${clienteNombre}!` : '¡Hola!';
    const introProductos = productosResumen
        ? `\n\nÚltima compra registrada:\n${productosResumen}`
        : '';

    if (conCupon && cupon) {
        const descTexto = cupon.tipo_descuento === 'monto_fijo'
            ? `$${Math.round(Number(cupon.valor_descuento) || 0).toLocaleString('es-AR')} OFF`
            : `${Number(cupon.valor_descuento) || 10}% OFF`;

        const fechaVto = cupon.valido_hasta
            ? new Date(cupon.valido_hasta).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })
            : '';

        return (
            `${saludo} Somos de *Distribuidora Mix Point* 🌰\n` +
            `Ya pasó casi un mes desde tu último pedido y queremos saber si necesitás reponer mercadería.${introProductos}\n\n` +
            `🎁 Como cliente frecuente, te regalamos un cupón de *${descTexto}*: *${cupon.codigo}*` +
            (fechaVto ? ` (válido hasta el ${fechaVto})` : '') +
            `.\n\n` +
            `Tocá este link para cargar automáticamente los mismos productos en tu carrito con el descuento aplicado:\n` +
            `${enlace}`
        );
    }

    return (
        `${saludo} Somos de *Distribuidora Mix Point* 🌰\n` +
        `Ya pasó casi un mes desde tu último pedido y te escribimos por si necesitás reponer mercadería.${introProductos}\n\n` +
        `Para ahorrarte tiempo, tocá este link y se cargan automáticamente los mismos productos en tu carrito para que lo ajustes o confirmes en 1 clic:\n` +
        `${enlace}`
    );
}

function buildWaUrl(telefono, mensaje) {
    const telWa = normalizarTelefonoWhatsApp(telefono);
    if (!telWa) return null;
    return `https://wa.me/${telWa}?text=${encodeURIComponent(mensaje)}`;
}

class RetencionService {
    /**
     * Marca carritos con más de 90 minutos de inactividad como 'abandonado',
     * notifica al panel y dispara webhook si hay integración activa.
     */
    static async detectarCarritosAbandonados() {
        const abandonados = await db.all(`
            UPDATE carritos_abandonados
            SET estado = 'abandonado', updated_at = NOW()
            WHERE estado = 'activo'
              AND jsonb_array_length(items) > 0
              AND total > 0
              AND ultima_actividad_at <= NOW() - INTERVAL '90 minutes'
              AND notificado_at IS NULL
            RETURNING *
        `);

        for (const c of abandonados) {
            const mensajeWa = buildMensajeCarrito(c);
            const waUrl = buildWaUrl(c.telefono, mensajeWa);
            const totalFmt = Math.round(Number(c.total) || 0).toLocaleString('es-AR');

            await db.run(`
                INSERT INTO notificaciones (tipo, titulo, mensaje, nivel, referencia_tipo, referencia_id, leida, created_at)
                VALUES ('carrito_abandonado', $1, $2, 'warning', 'carrito_abandonado', $3, false, NOW())
            `, [
                `🛒 Carrito abandonado (${c.cliente_nombre || c.telefono || 'Visitante'})`,
                `Dejó un carrito de $${totalFmt} hace más de 90 minutos (${Array.isArray(c.items) ? c.items.length : 0} ítems). Tel: ${c.telefono || '—'}.`,
                c.id
            ]).catch(() => {});

            const hookRes = await WebhookService.disparar({
                evento: 'CARRITO_ABANDONADO',
                datos: {
                    id: c.id,
                    session_id: c.session_id,
                    cliente_nombre: c.cliente_nombre,
                    telefono: c.telefono,
                    email: c.email,
                    total: Number(c.total) || 0,
                    items: c.items,
                    wa_url: waUrl,
                    mensaje_whatsapp: mensajeWa
                }
            }).catch(() => ({ ok: false }));

            if (hookRes && hookRes.ok && !hookRes.simulado) {
                await db.run(`
                    UPDATE carritos_abandonados
                    SET estado = 'notificado', notificado_at = NOW(), updated_at = NOW()
                    WHERE id = $1
                `, [c.id]).catch(() => {});
            }

            try {
                emitirEventoDeposito('retencion:carrito_abandonado', { id: c.id, total: Number(c.total) || 0 });
            } catch {}
        }

        if (abandonados.length > 0) {
            console.log(`🛒 [Retención] Detectados ${abandonados.length} carritos abandonados (>90 min).`);
        }

        return { detectados: abandonados.length, carritos: abandonados };
    }

    /**
     * Detecta clientes cuyo último remito entregado tiene entre 25 y 30 días de antigüedad
     * y no tienen pedidos ni remitos posteriores. NO genera cupón automáticamente;
     * el operador decide al enviar si incluir cupón o no.
     */
    static async detectarClientesReposicion() {
        const candidatos = await db.all(`
            WITH ultimos_remitos AS (
                SELECT
                    r.id AS remito_id,
                    r.numero,
                    r.cliente_id,
                    r.fecha,
                    r.estado,
                    r.total,
                    c.razon_social AS cliente_nombre,
                    c.telefono AS cliente_telefono,
                    ROW_NUMBER() OVER (PARTITION BY r.cliente_id ORDER BY r.fecha DESC, r.id DESC) AS rn
                FROM remitos r
                JOIN clientes c ON c.id = r.cliente_id
                WHERE c.activo = true
                  AND r.estado NOT IN ('cancelado', 'anulado')
            )
            SELECT ur.*
            FROM ultimos_remitos ur
            WHERE ur.rn = 1
              AND ur.estado = 'entregado'
              AND ur.fecha BETWEEN (CURRENT_DATE - INTERVAL '30 days')::date AND (CURRENT_DATE - INTERVAL '25 days')::date
              AND NOT EXISTS (
                  SELECT 1 FROM recordatorios_reposicion rr WHERE rr.remito_id = ur.remito_id
              )
              AND NOT EXISTS (
                  SELECT 1 FROM pedidos_web pw
                  WHERE pw.created_at::date > ur.fecha
                    AND pw.estado <> 'cancelado'
                    AND (
                        (COALESCE(ur.cliente_telefono, '') <> ''
                         AND regexp_replace(COALESCE(pw.telefono, ''), '[^0-9]', '', 'g') = regexp_replace(COALESCE(ur.cliente_telefono, ''), '[^0-9]', '', 'g'))
                        OR LOWER(TRIM(COALESCE(pw.cliente_nombre, ''))) = LOWER(TRIM(ur.cliente_nombre))
                    )
              )
            ORDER BY ur.fecha ASC
        `);

        const nuevos = [];
        for (const row of candidatos) {
            const enlace = `${STORE_URL}/reponer/${row.remito_id}`;
            const { row: inserted } = await db.run(`
                INSERT INTO recordatorios_reposicion (cliente_id, remito_id, cupon_id, telefono, enlace_recompra, estado)
                VALUES ($1, $2, NULL, $3, $4, 'pendiente')
                ON CONFLICT (remito_id) DO NOTHING
                RETURNING *
            `, [row.cliente_id, row.remito_id, row.cliente_telefono || null, enlace]);

            if (inserted) {
                nuevos.push({ ...inserted, cliente_nombre: row.cliente_nombre, remito_numero: row.numero });
            }
        }

        if (nuevos.length > 0) {
            await db.run(`
                INSERT INTO notificaciones (tipo, titulo, mensaje, nivel, referencia_tipo, referencia_id, leida, created_at)
                VALUES ('reposicion_pendiente', $1, $2, 'info', 'recordatorios_reposicion', $3, false, NOW())
            `, [
                `🔁 ${nuevos.length} cliente(s) en ventana de reposición (25–30 días)`,
                `Clientes listos para contactar por reposición: ${nuevos.slice(0, 4).map(n => n.cliente_nombre).join(', ')}${nuevos.length > 4 ? '...' : ''}.`,
                nuevos[0].id
            ]).catch(() => {});

            try {
                emitirEventoDeposito('retencion:reposicion_detectada', { cantidad: nuevos.length });
            } catch {}

            console.log(`🔁 [Retención] Detectados ${nuevos.length} clientes nuevos en ventana de reposición (25-30 días).`);
        }

        return { detectados: nuevos.length, recordatorios: nuevos };
    }

    /**
     * Prepara el envío de WhatsApp (y webhook si corresponde) para un recordatorio de reposición,
     * permitiendo elegir explícitamente si se envía CON cupón de descuento o SIN cupón.
     */
    static async prepararEnvioReposicion(recordatorioId, { con_cupon = false, porcentaje = 10, dias_validez = 7 } = {}) {
        const rec = await db.one(`
            SELECT rr.*, c.razon_social AS cliente_nombre, c.telefono AS cliente_telefono,
                   r.numero AS remito_numero, r.fecha AS remito_fecha, r.total AS remito_total
            FROM recordatorios_reposicion rr
            JOIN clientes c ON c.id = rr.cliente_id
            JOIN remitos r ON r.id = rr.remito_id
            WHERE rr.id = $1
        `, [recordatorioId]);

        if (!rec) {
            const err = new Error('Recordatorio de reposición no encontrado.');
            err.status = 404;
            throw err;
        }

        const itemsRemito = await db.all(`
            SELECT p.nombre, ri.cantidad, p.unidad_medida, ri.descripcion
            FROM remito_items ri
            JOIN productos p ON p.id = ri.producto_id
            WHERE ri.remito_id = $1
            ORDER BY ri.id ASC
        `, [rec.remito_id]);

        const productosResumen = itemsRemito.slice(0, 5).map(it =>
            `• ${it.nombre} (${Number(it.cantidad) || 0} ${it.unidad_medida || 'kg'}${it.descripcion ? ` · ${it.descripcion}` : ''})`
        ).join('\n') + (itemsRemito.length > 5 ? `\n• ...y ${itemsRemito.length - 5} ítem(s) más` : '');

        let cuponObj = null;
        let enlace = `${STORE_URL}/reponer/${rec.remito_id}`;
        const usarCupon = Boolean(con_cupon);

        if (usarCupon) {
            const pct = Math.max(1, Math.min(90, Number(porcentaje) || 10));
            const dias = Math.max(1, Math.min(60, parseInt(dias_validez, 10) || 7));

            if (rec.cupon_id) {
                const existente = await db.one(`
                    SELECT * FROM cupones
                    WHERE id = $1 AND activo = true AND valido_hasta > NOW() AND usos_actuales < usos_maximos
                `, [rec.cupon_id]);
                if (existente && Number(existente.valor_descuento) === pct) {
                    cuponObj = existente;
                }
            }

            if (!cuponObj) {
                for (let intento = 0; intento < 5; intento++) {
                    const codigo = generarCodigoCupon('REPONER');
                    try {
                        const { row } = await db.run(`
                            INSERT INTO cupones (
                                codigo, tipo_descuento, valor_descuento, cliente_id,
                                telefono_cliente, remito_origen_id, usos_maximos, valido_hasta, activo
                            )
                            VALUES ($1, 'porcentaje', $2, $3, $4, $5, 1, NOW() + ($6::int * INTERVAL '1 day'), true)
                            RETURNING *
                        `, [codigo, pct, rec.cliente_id, rec.telefono || rec.cliente_telefono || null, rec.remito_id, dias]);
                        cuponObj = row;
                        break;
                    } catch (e) {
                        if (intento === 4) throw e;
                    }
                }
            }

            enlace = `${STORE_URL}/reponer/${rec.remito_id}?cupon=${encodeURIComponent(cuponObj.codigo)}`;

            await db.run(`
                UPDATE recordatorios_reposicion
                SET cupon_id = $1, enlace_recompra = $2, enviado_con_cupon = true, estado = 'enviado', notificado_at = NOW()
                WHERE id = $3
            `, [cuponObj.id, enlace, rec.id]);
        } else {
            await db.run(`
                UPDATE recordatorios_reposicion
                SET enlace_recompra = $1, enviado_con_cupon = false, estado = 'enviado', notificado_at = NOW()
                WHERE id = $2
            `, [enlace, rec.id]);
        }

        const telFinal = rec.telefono || rec.cliente_telefono || '';
        const mensajeWhatsapp = buildMensajeReposicion({
            clienteNombre: rec.cliente_nombre,
            productosResumen,
            enlace,
            conCupon: usarCupon,
            cupon: cuponObj
        });
        const waUrl = buildWaUrl(telFinal, mensajeWhatsapp);

        WebhookService.disparar({
            evento: 'RECORDATORIO_REPOSICION',
            datos: {
                recordatorio_id: rec.id,
                cliente_id: rec.cliente_id,
                cliente_nombre: rec.cliente_nombre,
                telefono: telFinal,
                remito_id: rec.remito_id,
                remito_numero: rec.remito_numero,
                enviado_con_cupon: usarCupon,
                cupon: cuponObj,
                enlace,
                wa_url: waUrl,
                mensaje_whatsapp: mensajeWhatsapp
            }
        }).catch(() => {});

        try {
            emitirEventoDeposito('retencion:reposicion_actualizada', { id: rec.id });
        } catch {}

        return {
            ok: true,
            enlace,
            cupon: cuponObj,
            enviado_con_cupon: usarCupon,
            mensaje_whatsapp: mensajeWhatsapp,
            wa_url: waUrl
        };
    }
}

RetencionService.normalizarTelefonoWhatsApp = normalizarTelefonoWhatsApp;
RetencionService.buildMensajeCarrito = buildMensajeCarrito;
RetencionService.buildWaUrl = buildWaUrl;
RetencionService.generarCodigoCupon = generarCodigoCupon;
RetencionService.STORE_URL = STORE_URL;

module.exports = RetencionService;
