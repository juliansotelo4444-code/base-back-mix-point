const db = require('../db/pool');
const AlertasService = require('./alertasService');

/**
 * Servicio de Generación y Envío de Reporte Diario Ejecutivo (8:00 AM)
 */
class ReporteDiarioService {
    /**
     * Recopila datos de ventas, cobranzas y stock del día anterior o fecha especificada
     */
    static async generarDatosReporte(fechaRef = null) {
        // Por defecto toma la fecha de "ayer"
        const fechaTarget = fechaRef || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const hoy = new Date().toISOString().slice(0, 10);

        // 1. Ventas del día (remitos)
        const ventasRow = await db.one(`
            SELECT 
                COUNT(*)::int as total_remitos,
                COALESCE(SUM(total), 0) as total_facturado
            FROM remitos 
            WHERE fecha = $1
        `, [fechaTarget]);

        // 2. Cobranzas registradas (abonos de clientes)
        const cobranzasRow = await db.one(`
            SELECT 
                COUNT(*)::int as total_cobros,
                COALESCE(SUM(monto), 0) as total_cobrado
            FROM movimientos_cuenta
            WHERE entidad_tipo = 'cliente' 
              AND tipo IN ('cobro', 'pago')
              AND fecha::date = $1::date
        `, [fechaTarget]);

        // 3. Top 3 productos más vendidos en el día
        const topProductos = await db.all(`
            SELECT 
                p.nombre,
                p.unidad_medida,
                SUM(ri.cantidad) as total_cantidad,
                SUM(ri.subtotal) as total_monto
            FROM remito_items ri
            JOIN remitos r ON r.id = ri.remito_id
            JOIN productos p ON p.id = ri.producto_id
            WHERE r.fecha = $1
            GROUP BY p.nombre, p.unidad_medida
            ORDER BY total_cantidad DESC
            LIMIT 3
        `, [fechaTarget]);

        // 4. Deuda en la calle (saldo acumulado de todos los clientes)
        const deudaCalleRow = await db.one(`
            SELECT COALESCE(SUM(saldo_cuenta), 0) as total_deuda
            FROM clientes
            WHERE saldo_cuenta > 0
        `);

        // 5. Stock crítico / agotado actual
        const stockCritico = await db.all(`
            SELECT codigo, nombre, stock_actual, stock_minimo, unidad_medida
            FROM productos
            WHERE activo = true AND stock_actual <= stock_minimo
            ORDER BY stock_actual ASC
            LIMIT 5
        `);

        // 6. Lotes próximos a vencer en los siguientes 30 días
        const lotesPorVencer = await db.all(`
            SELECT l.numero_lote, l.fecha_vencimiento, l.cantidad_actual, p.nombre as producto_nombre
            FROM lotes l
            JOIN productos p ON p.id = l.producto_id
            WHERE l.cantidad_actual > 0 
              AND l.fecha_vencimiento IS NOT NULL
              AND l.fecha_vencimiento <= CURRENT_DATE + INTERVAL '30 days'
            ORDER BY l.fecha_vencimiento ASC
            LIMIT 3
        `);

        return {
            fecha: fechaTarget,
            fecha_generacion: hoy,
            ventas: {
                cantidad: ventasRow ? ventasRow.total_remitos : 0,
                monto: Number(ventasRow ? ventasRow.total_facturado : 0)
            },
            cobranzas: {
                cantidad: cobranzasRow ? cobranzasRow.total_cobros : 0,
                monto: Number(cobranzasRow ? cobranzasRow.total_cobrado : 0)
            },
            topProductos: topProductos.map(t => ({
                nombre: t.nombre,
                unidad: t.unidad_medida,
                cantidad: Number(t.total_cantidad),
                monto: Number(t.total_monto)
            })),
            deudaTotal: Number(deudaCalleRow ? deudaCalleRow.total_deuda : 0),
            stockCritico: stockCritico.map(s => ({
                codigo: s.codigo,
                nombre: s.nombre,
                stock: Number(s.stock_actual),
                minimo: Number(s.stock_minimo),
                unidad: s.unidad_medida
            })),
            lotesPorVencer: lotesPorVencer.map(l => ({
                lote: l.numero_lote,
                producto: l.producto_nombre,
                vence: String(l.fecha_vencimiento).slice(0, 10),
                cantidad: Number(l.cantidad_actual)
            }))
        };
    }

    /**
     * Da formato amigable para WhatsApp / Telegram con emojis y texto conciso
     */
    static formatearMensaje(datos) {
        const fmtMoneda = (n) => `$ ${Number(n).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
        const fPartes = datos.fecha.split('-');
        const fechaFormateada = fPartes.length === 3 ? `${fPartes[2]}/${fPartes[1]}/${fPartes[0]}` : datos.fecha;

        let txt = `📊 *MIX POINT - REPORTE EJECUTIVO*\n`;
        txt += `📅 *Jornada:* ${fechaFormateada}\n\n`;

        txt += `💰 *VENTAS DEL DÍA*\n`;
        txt += `• Facturado: *${fmtMoneda(datos.ventas.monto)}*\n`;
        txt += `• Remitos emitidos: *${datos.ventas.cantidad}*\n\n`;

        txt += `💵 *COBRANZAS INGRESADAS*\n`;
        txt += `• Total cobrado: *${fmtMoneda(datos.cobranzas.monto)}* (${datos.cobranzas.cantidad} pagos)\n`;
        txt += `• Saldo en la calle: *${fmtMoneda(datos.deudaTotal)}*\n\n`;

        if (datos.topProductos.length > 0) {
            txt += `⭐ *TOP PRODUCTOS VENDIDOS*\n`;
            datos.topProductos.forEach((p, idx) => {
                txt += `${idx + 1}. ${p.nombre}: *${p.cantidad} ${p.unidad}* (${fmtMoneda(p.monto)})\n`;
            });
            txt += `\n`;
        }

        if (datos.stockCritico.length > 0) {
            txt += `⚠️ *ALERTAS DE STOCK (${datos.stockCritico.length})*\n`;
            datos.stockCritico.forEach(s => {
                const icon = s.stock <= 0 ? '🚨' : '⚠️';
                txt += `${icon} ${s.nombre}: *${s.stock} ${s.unidad}* (Mín: ${s.minimo})\n`;
            });
            txt += `\n`;
        } else {
            txt += `✅ *Stock:* Niveles óptimos en todos los ítems.\n\n`;
        }

        if (datos.lotesPorVencer.length > 0) {
            txt += `⏳ *VENCIMIENTOS PRÓXIMOS (30 días)*\n`;
            datos.lotesPorVencer.forEach(l => {
                txt += `• ${l.producto} (${l.lote}): vence ${l.vence} (${l.cantidad} disp.)\n`;
            });
            txt += `\n`;
        }

        txt += `_Mix Point Management System v2.0_`;
        return txt;
    }

    /**
     * Envía el reporte a todos los canales configurados (Telegram, Webhook, Notificación interna)
     */
    static async enviarReporte(fechaRef = null) {
        const datos = await this.generarDatosReporte(fechaRef);
        const mensajeTexto = this.formatearMensaje(datos);

        const envios = [];

        // 1. Notificación interna en el sistema
        try {
            await AlertasService.registrarNotificacion({
                tipo: 'reporte_diario',
                titulo: `📊 Reporte Diario Mix Point (${datos.fecha})`,
                mensaje: `Ventas: $${datos.ventas.monto.toLocaleString('es-AR')} | Cobranzas: $${datos.cobranzas.monto.toLocaleString('es-AR')} | ${datos.stockCritico.length} alertas de stock`,
                nivel: 'info'
            });
            envios.push('Notificación interna generada.');
        } catch (e) {
            console.error('Error registrando notificación de reporte:', e.message);
        }

        // 2. Telegram Bot
        try {
            const telegramToken = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'telegram_bot_token'");
            const telegramChatId = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'telegram_chat_id'");

            if (telegramToken && telegramToken.valor && telegramChatId && telegramChatId.valor) {
                const url = `https://api.telegram.org/bot${telegramToken.valor}/sendMessage`;
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: telegramChatId.valor,
                        text: mensajeTexto,
                        parse_mode: 'Markdown'
                    })
                });
                if (res.ok) envios.push('Enviado a Telegram.');
            }
        } catch (e) {
            console.error('Error enviando a Telegram:', e.message);
        }

        // 3. Webhook de WhatsApp / Integrador
        try {
            const webhookUrl = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'reporte_webhook_url'");
            if (webhookUrl && webhookUrl.valor) {
                const res = await fetch(webhookUrl.valor, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        tipo: 'REPORTE_DIARIO',
                        fecha: datos.fecha,
                        mensaje: mensajeTexto,
                        datos_estructurados: datos
                    })
                });
                if (res.ok) envios.push('Enviado a Webhook.');
            }
        } catch (e) {
            console.error('Error enviando a Webhook:', e.message);
        }

        // Guardar fecha de último envío
        const hoy = new Date().toISOString().slice(0, 10);
        await db.run(`
            INSERT INTO configuracion_sistema (clave, valor, updated_at)
            VALUES ('ultimo_reporte_enviado', $1, NOW())
            ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()
        `, [hoy]);

        return {
            ok: true,
            datos,
            mensajeTexto,
            envios
        };
    }

    /**
     * Comprueba si son las 08:00 AM en hora de Argentina y no se envió hoy
     */
    static async verificarDisparoAutomatico() {
        try {
            // Obtener hora actual en Buenos Aires
            const ahoraBA = new Intl.DateTimeFormat('es-AR', {
                timeZone: 'America/Argentina/Buenos_Aires',
                hour: 'numeric',
                minute: 'numeric',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour12: false
            }).formatToParts(new Date());

            const hora = parseInt(ahoraBA.find(p => p.type === 'hour')?.value || '0', 10);
            const minuto = parseInt(ahoraBA.find(p => p.type === 'minute')?.value || '0', 10);
            const anio = ahoraBA.find(p => p.type === 'year')?.value;
            const mes = ahoraBA.find(p => p.type === 'month')?.value;
            const dia = ahoraBA.find(p => p.type === 'day')?.value;
            const hoyStr = `${anio}-${mes}-${dia}`;

            // Ventana de disparo: entre las 8:00 y las 8:15 AM
            if (hora === 8 && minuto >= 0 && minuto <= 15) {
                const ultimoEnvio = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'ultimo_reporte_enviado'");
                if (!ultimoEnvio || ultimoEnvio.valor !== hoyStr) {
                    console.log(`[Reporte Diario] ⏰ Disparando reporte matutino programado para ${hoyStr}...`);
                    await this.enviarReporte();
                }
            }
        } catch (err) {
            console.error('Error en scheduler de reporte diario:', err.message);
        }
    }
}

module.exports = ReporteDiarioService;
