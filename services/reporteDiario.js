const db = require('../db/pool');
const AlertasService = require('./alertasService');

/**
 * Servicio de Generación y Envío de Reporte Diario Ejecutivo (8:00 AM)
 */
class ReporteDiarioService {
    /**
     * Recopila datos de ventas, cobranzas y stock del día anterior o fecha especificada
     */
    /**
     * Recopila datos de ventas, cobranzas y stock del día anterior o fecha especificada
     */
    static async generarDatosReporte(fechaRef = null) {
        // Horarios locales seguros de Argentina
        const ayerBA = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Argentina/Buenos_Aires',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(new Date(Date.now() - 24 * 60 * 60 * 1000));

        const hoyBA = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Argentina/Buenos_Aires',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(new Date());

        const fechaTarget = fechaRef || ayerBA;
        const [anioStr, mesStr] = fechaTarget.split('-');
        const inicioMesStr = `${anioStr}-${mesStr}-01`;

        // 1. Ventas del día (remitos válidos de la jornada)
        const ventasRow = await db.one(`
            SELECT 
                COUNT(*)::int as total_remitos,
                COALESCE(SUM(total), 0)::float as total_facturado
            FROM remitos 
            WHERE fecha = $1 AND estado NOT IN ('anulado', 'cancelado')
        `, [fechaTarget]);

        // 2. Gastos del día
        const gastosRow = await db.one(`
            SELECT 
                COUNT(*)::int as total_gastos,
                COALESCE(SUM(monto), 0)::float as total_gastado
            FROM gastos
            WHERE fecha = $1
        `, [fechaTarget]);

        // 3. Cobranzas registradas (abonos de clientes en el día)
        const cobranzasRow = await db.one(`
            SELECT 
                COUNT(*)::int as total_cobros,
                COALESCE(SUM(monto), 0)::float as total_cobrado
            FROM movimientos_cuenta
            WHERE entidad_tipo = 'cliente' 
              AND tipo IN ('cobro', 'pago')
              AND fecha::date = $1::date
        `, [fechaTarget]);

        // 4. Acumulado del mes a la fecha (termómetro comercial)
        const acumuladoMesRow = await db.one(`
            SELECT 
                COUNT(*)::int as total_remitos_mes,
                COALESCE(SUM(total), 0)::float as total_facturado_mes
            FROM remitos
            WHERE fecha >= $1 AND fecha <= $2 AND estado NOT IN ('anulado', 'cancelado')
        `, [inicioMesStr, fechaTarget]);

        // 5. Pedidos pendientes en depósito y logística hoy
        const pendientesRows = await db.all(`
            SELECT estado, COUNT(*)::int as cantidad, COALESCE(SUM(total), 0)::float as monto
            FROM remitos
            WHERE estado IN ('pendiente', 'en_preparacion', 'en_camino')
            GROUP BY estado
        `);
        const pendientesMap = {};
        pendientesRows.forEach(p => { pendientesMap[p.estado] = { cantidad: p.cantidad, monto: p.monto }; });

        // 6. Top 3 productos más vendidos en el día
        const topProductos = await db.all(`
            SELECT 
                p.nombre,
                p.unidad_medida,
                SUM(ri.cantidad)::float as total_cantidad,
                SUM(ri.subtotal)::float as total_monto
            FROM remito_items ri
            JOIN remitos r ON r.id = ri.remito_id
            JOIN productos p ON p.id = ri.producto_id
            WHERE r.fecha = $1 AND r.estado NOT IN ('anulado', 'cancelado')
            GROUP BY p.nombre, p.unidad_medida
            ORDER BY total_cantidad DESC
            LIMIT 3
        `, [fechaTarget]);

        // 7. Deuda total acumulada en la calle
        const deudaCalleRow = await db.one(`
            SELECT COALESCE(SUM(saldo_cuenta), 0)::float as total_deuda
            FROM clientes
            WHERE saldo_cuenta > 0
        `);

        // 8. Stock crítico / agotado actual
        const stockCritico = await db.all(`
            SELECT codigo, nombre, stock_actual, stock_minimo, unidad_medida
            FROM productos
            WHERE activo = true AND stock_actual <= stock_minimo
            ORDER BY stock_actual ASC
            LIMIT 5
        `);

        // 9. Lotes próximos a vencer en los siguientes 30 días
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

        // 10. Oportunidades de retención comercial
        const retencionRow = await db.one(`
            SELECT 
                (SELECT COUNT(*)::int FROM carritos_abandonados WHERE estado = 'abandonado') as carritos_abandonados,
                (SELECT COUNT(*)::int FROM recordatorios_reposicion WHERE estado = 'pendiente') as reposiciones_pendientes
        `).catch(() => ({ carritos_abandonados: 0, reposiciones_pendientes: 0 }));

        const ventasDia = Number(ventasRow ? ventasRow.total_facturado : 0);
        const gastosDia = Number(gastosRow ? gastosRow.total_gastado : 0);
        const balanceDia = Number((ventasDia - gastosDia).toFixed(2));

        return {
            fecha: fechaTarget,
            fecha_generacion: hoyBA,
            ventas: {
                cantidad: ventasRow ? ventasRow.total_remitos : 0,
                monto: ventasDia
            },
            gastos: {
                cantidad: gastosRow ? gastosRow.total_gastos : 0,
                monto: gastosDia
            },
            balanceDia,
            cobranzas: {
                cantidad: cobranzasRow ? cobranzasRow.total_cobros : 0,
                monto: Number(cobranzasRow ? cobranzasRow.total_cobrado : 0)
            },
            acumuladoMes: {
                cantidad: acumuladoMesRow ? acumuladoMesRow.total_remitos_mes : 0,
                monto: Number(acumuladoMesRow ? acumuladoMesRow.total_facturado_mes : 0),
                mes: mesStr,
                anio: anioStr
            },
            pendientesOperativos: {
                pendiente: pendientesMap['pendiente'] || { cantidad: 0, monto: 0 },
                en_preparacion: pendientesMap['en_preparacion'] || { cantidad: 0, monto: 0 },
                en_camino: pendientesMap['en_camino'] || { cantidad: 0, monto: 0 },
                totalCantidad: (pendientesMap['pendiente']?.cantidad || 0) + (pendientesMap['en_preparacion']?.cantidad || 0) + (pendientesMap['en_camino']?.cantidad || 0),
                totalMonto: (pendientesMap['pendiente']?.monto || 0) + (pendientesMap['en_preparacion']?.monto || 0) + (pendientesMap['en_camino']?.monto || 0)
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
            })),
            retencion: {
                carritos: Number(retencionRow?.carritos_abandonados || 0),
                reposiciones: Number(retencionRow?.reposiciones_pendientes || 0)
            }
        };
    }

    /**
     * Da formato visual ejecutivo de alto impacto para WhatsApp / Telegram
     */
    static formatearMensaje(datos) {
        const fmtMoneda = (n) => `$ ${Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
        const fPartes = (datos.fecha || '').split('-');
        const fechaFormateada = fPartes.length === 3 ? `${fPartes[2]}/${fPartes[1]}/${fPartes[0]}` : datos.fecha;

        const mesesNombres = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
        const nombreMes = datos.acumuladoMes?.mes ? (mesesNombres[parseInt(datos.acumuladoMes.mes, 10) - 1] || 'Mes') : 'Mes';

        let txt = `📊 *MIX POINT · REPORTE MATUTINO (8:00 AM)*\n`;
        txt += `📅 *Jornada:* ${fechaFormateada}\n`;
        txt += `━━━━━━━━━━━━━━━━━━━━\n\n`;

        txt += `💰 *VENTAS Y CAJA DEL DÍA*\n`;
        txt += `• Facturado: *${fmtMoneda(datos.ventas.monto)}* (${datos.ventas.cantidad} pedidos)\n`;
        txt += `• Cobranzas: *${fmtMoneda(datos.cobranzas.monto)}* (${datos.cobranzas.cantidad} pagos ingresados)\n`;
        if (datos.gastos && datos.gastos.monto > 0) {
            txt += `• Gastos: *${fmtMoneda(datos.gastos.monto)}* (${datos.gastos.cantidad} registros)\n`;
            txt += `• Balance del día: *${datos.balanceDia >= 0 ? '+' : ''}${fmtMoneda(datos.balanceDia)}*\n`;
        }
        txt += `\n`;

        txt += `📈 *ACUMULADO MENSUAL (${nombreMes} ${datos.acumuladoMes?.anio || ''})*\n`;
        txt += `• Facturación acumulada: *${fmtMoneda(datos.acumuladoMes?.monto)}* (${datos.acumuladoMes?.cantidad} remitos válidos)\n`;
        txt += `• Cartera / Saldo en la calle: *${fmtMoneda(datos.deudaTotal)}*\n\n`;

        if (datos.pendientesOperativos && datos.pendientesOperativos.totalCantidad > 0) {
            txt += `🚚 *LOGÍSTICA Y DEPÓSITO HOY*\n`;
            if (datos.pendientesOperativos.pendiente.cantidad > 0) {
                txt += `• Por preparar: *${datos.pendientesOperativos.pendiente.cantidad} pedidos* (${fmtMoneda(datos.pendientesOperativos.pendiente.monto)})\n`;
            }
            if (datos.pendientesOperativos.en_preparacion.cantidad > 0) {
                txt += `• En preparación: *${datos.pendientesOperativos.en_preparacion.cantidad} pedidos* (${fmtMoneda(datos.pendientesOperativos.en_preparacion.monto)})\n`;
            }
            if (datos.pendientesOperativos.en_camino.cantidad > 0) {
                txt += `• En reparto: *${datos.pendientesOperativos.en_camino.cantidad} pedidos* (${fmtMoneda(datos.pendientesOperativos.en_camino.monto)})\n`;
            }
            txt += `👉 *Total operativo activo:* ${datos.pendientesOperativos.totalCantidad} pedidos (${fmtMoneda(datos.pendientesOperativos.totalMonto)})\n\n`;
        }

        if (datos.topProductos && datos.topProductos.length > 0) {
            txt += `⭐ *TOP PRODUCTOS VENDIDOS*\n`;
            datos.topProductos.forEach((p, idx) => {
                txt += `${idx + 1}. ${p.nombre}: *${p.cantidad} ${p.unidad}* (${fmtMoneda(p.monto)})\n`;
            });
            txt += `\n`;
        }

        if (datos.stockCritico && datos.stockCritico.length > 0) {
            txt += `⚠️ *ALERTAS DE STOCK (${datos.stockCritico.length} ítems)*\n`;
            datos.stockCritico.forEach(s => {
                const icon = s.stock <= 0 ? '🚨' : '⚠️';
                txt += `${icon} ${s.nombre}: *${s.stock} ${s.unidad}* (Mín: ${s.minimo})\n`;
            });
            txt += `\n`;
        } else {
            txt += `✅ *Stock:* Niveles óptimos en depósito.\n\n`;
        }

        if (datos.lotesPorVencer && datos.lotesPorVencer.length > 0) {
            txt += `⏳ *VENCIMIENTOS PRÓXIMOS (30 días)*\n`;
            datos.lotesPorVencer.forEach(l => {
                txt += `• ${l.producto} (${l.lote || 'L-GRAL'}): vence ${l.vence} (${l.cantidad} disp.)\n`;
            });
            txt += `\n`;
        }

        if (datos.retencion && (datos.retencion.carritos > 0 || datos.retencion.reposiciones > 0)) {
            txt += `🎯 *OPORTUNIDADES DE RETENCIÓN*\n`;
            if (datos.retencion.carritos > 0) {
                txt += `• ${datos.retencion.carritos} carrito(s) abandonado(s) listos para recuperar\n`;
            }
            if (datos.retencion.reposiciones > 0) {
                txt += `• ${datos.retencion.reposiciones} cliente(s) para recordatorio de reposición (25-30 días)\n`;
            }
            txt += `\n`;
        }

        txt += `━━━━━━━━━━━━━━━━━━━━\n`;
        txt += `_Mix Point HQ · Telemetría en Vivo_`;
        return txt;
    }

    /**
     * Envía el reporte a todos los canales configurados (Telegram, Webhook, WhatsApp CallMeBot, Notificación interna)
     */
    static async enviarReporte(fechaRef = null, esAutomatico = false) {
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

        // 4. WhatsApp Directo vía CallMeBot a cada destinatario configurado
        try {
            const destRow = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'callmebot_destinatarios'");
            let destinatarios = [];
            if (destRow && destRow.valor) {
                try {
                    destinatarios = JSON.parse(destRow.valor);
                } catch {}
            }

            if (Array.isArray(destinatarios) && destinatarios.length > 0) {
                for (const d of destinatarios) {
                    const telefono = String(d.telefono || '').replace(/[^0-9]/g, '');
                    const apikey = String(d.apikey || '').trim();
                    const nombre = d.nombre ? String(d.nombre).trim() : telefono;
                    if (!telefono || !apikey) continue;

                    try {
                        const url = `https://api.callmebot.com/whatsapp.php?phone=${telefono}&text=${encodeURIComponent(mensajeTexto)}&apikey=${apikey}`;
                        const res = await fetch(url);
                        if (res.ok) {
                            envios.push(`WhatsApp enviado a ${nombre} (${telefono}).`);
                        } else {
                            const errTxt = await res.text().catch(() => '');
                            console.error(`Error CallMeBot para ${telefono}:`, res.status, errTxt);
                            envios.push(`WhatsApp ${nombre}: Error HTTP ${res.status}`);
                        }
                    } catch (errBot) {
                        console.error(`Error enviando WhatsApp a ${telefono}:`, errBot.message);
                        envios.push(`WhatsApp ${nombre}: ${errBot.message}`);
                    }
                }
            }
        } catch (e) {
            console.error('Error enviando por CallMeBot:', e.message);
        }

        // Guardar fecha de último envío solo si fue disparo automático diario
        if (esAutomatico) {
            const hoy = new Date().toISOString().slice(0, 10);
            await db.run(`
                INSERT INTO configuracion_sistema (clave, valor, updated_at)
                VALUES ('ultimo_reporte_enviado', $1, NOW())
                ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()
            `, [hoy]);
        }

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
                    await this.enviarReporte(null, true);
                }
            }
        } catch (err) {
            console.error('Error en scheduler de reporte diario:', err.message);
        }
    }
}

module.exports = ReporteDiarioService;
