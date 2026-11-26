const db = require('../db/pool');

/**
 * Servicio centralizado de alertas y notificaciones del sistema
 */
class AlertasService {
    /**
     * Verifica si un producto alcanzó stock crítico o stock cero y crea la notificación.
     * Implementa 'throttling' para no repetir la misma alerta dentro de 6 horas a menos que cambie de nivel.
     */
    static async verificarStockProducto(productoId) {
        try {
            const producto = await db.one(`
                SELECT id, codigo, nombre, stock_actual, stock_minimo, unidad_medida 
                FROM productos 
                WHERE id = $1 AND activo = true
            `, [productoId]);

            if (!producto) return;

            const stock = Number(producto.stock_actual);
            const stockMin = Number(producto.stock_minimo) || 20;

            if (stock <= stockMin) {
                const esCero = stock <= 0;
                const tipo = esCero ? 'stock_cero' : 'stock_minimo';
                const nivel = esCero ? 'danger' : 'warning';
                const titulo = esCero 
                    ? `🚨 Stock Agotado: ${producto.nombre}` 
                    : `⚠️ Stock Bajo: ${producto.nombre}`;
                const mensaje = esCero
                    ? `El producto "${producto.nombre}" (${producto.codigo || 'S/C'}) no tiene unidades disponibles.`
                    : `El producto "${producto.nombre}" (${producto.codigo || 'S/C'}) tiene ${stock} ${producto.unidad_medida}. Umbral mínimo: ${stockMin} ${producto.unidad_medida}.`;

                // Verificar si ya existe una alerta idéntica no leída o creada en las últimas 6 horas
                const alertaReciente = await db.one(`
                    SELECT id FROM notificaciones 
                    WHERE tipo = $1 
                      AND referencia_tipo = 'producto' 
                      AND referencia_id = $2 
                      AND (leida = false OR created_at > NOW() - INTERVAL '6 hours')
                    ORDER BY created_at DESC 
                    LIMIT 1
                `, [tipo, producto.id]);

                if (!alertaReciente) {
                    await db.run(`
                        INSERT INTO notificaciones (tipo, titulo, mensaje, nivel, referencia_tipo, referencia_id, leida)
                        VALUES ($1, $2, $3, $4, 'producto', $5, false)
                    `, [tipo, titulo, mensaje, nivel, producto.id]);

                    // Si hay un webhook de WhatsApp/Telegram configurado, se envía en segundo plano
                    this.notificarCanalExterno(titulo, mensaje).catch(err => {
                        console.error('Error enviando notificación externa:', err.message);
                    });
                }
            }
        } catch (err) {
            console.error('Error en verificarStockProducto:', err);
        }
    }

    /**
     * Verifica múltiples productos (por ejemplo tras una venta o producción masiva)
     */
    static async verificarMultiplesProductos(productoIds) {
        if (!Array.isArray(productoIds) || productoIds.length === 0) return;
        const idsUnicos = [...new Set(productoIds.filter(Boolean))];
        for (const id of idsUnicos) {
            await this.verificarStockProducto(id);
        }
    }

    /**
     * Registra una notificación genérica (conciliación, sincronización, etc.)
     */
    static async registrarNotificacion({ tipo, titulo, mensaje, nivel = 'info', referencia_tipo = null, referencia_id = null }) {
        try {
            await db.run(`
                INSERT INTO notificaciones (tipo, titulo, mensaje, nivel, referencia_tipo, referencia_id, leida)
                VALUES ($1, $2, $3, $4, $5, $6, false)
            `, [tipo, titulo, mensaje, nivel, referencia_tipo, referencia_id]);
        } catch (err) {
            console.error('Error al registrar notificación:', err);
        }
    }

    /**
     * Envía notificación a Telegram, WhatsApp (CallMeBot) o Webhook si están configurados en configuracion_sistema
     */
    static async notificarCanalExterno(titulo, mensaje) {
        try {
            // 1. Telegram Bot
            const telegramToken = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'telegram_bot_token'").catch(() => null);
            const telegramChatId = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'telegram_chat_id'").catch(() => null);

            if (telegramToken && telegramToken.valor && telegramChatId && telegramChatId.valor) {
                const text = `*Mix Point - Alerta Sistema*\n\n${titulo}\n${mensaje}`;
                const url = `https://api.telegram.org/bot${telegramToken.valor}/sendMessage`;
                fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: telegramChatId.valor,
                        text,
                        parse_mode: 'Markdown'
                    })
                }).catch(e => console.warn('Error Telegram alerta:', e.message));
            }

            // 2. Webhook genérico (WhatsApp gateway, Zapier, Make, etc.)
            const webhookUrl = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'alertas_webhook_url'").catch(() => null);
            if (webhookUrl && webhookUrl.valor) {
                fetch(webhookUrl.valor, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        origen: 'Mix Point Alertas',
                        titulo,
                        mensaje,
                        timestamp: new Date().toISOString()
                    })
                }).catch(e => console.warn('Error Webhook alerta:', e.message));
            }

            // 3. WhatsApp Directo (CallMeBot)
            const destRow = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'callmebot_destinatarios'").catch(() => null);
            let destinatarios = [];
            if (destRow && destRow.valor) {
                try { destinatarios = JSON.parse(destRow.valor); } catch {}
            }

            if (Array.isArray(destinatarios) && destinatarios.length > 0) {
                const textoWhatsApp = `⚠️ *MIX POINT · ALERTA*\n\n*${titulo}*\n${mensaje}`;
                for (const d of destinatarios) {
                    const tel = String(d.telefono || '').replace(/[^0-9]/g, '');
                    const key = String(d.apikey || '').trim();
                    if (!tel || !key) continue;

                    const url = `https://api.callmebot.com/whatsapp.php?phone=${tel}&text=${encodeURIComponent(textoWhatsApp)}&apikey=${key}`;
                    fetch(url).catch(e => console.warn(`Error WhatsApp CallMeBot a ${tel}:`, e.message));
                }
            }
        } catch (err) {
            console.warn('Alerta externa no enviada:', err.message);
        }
    }

    /**
     * Notifica en tiempo real la llegada de un nuevo pedido (web o remito) a WhatsApp CallMeBot, Telegram y Webhook
     */
    static async notificarNuevoPedido(pedido) {
        try {
            const numero = pedido.numero || 'S/N';
            const cliente = pedido.cliente_nombre || pedido.nombre || 'Cliente Web';
            const total = Number(pedido.total) || 0;
            const telefono = pedido.telefono || '';
            const direccion = pedido.direccion || '';
            const zona = pedido.zona || '';
            const horario = pedido.horario_entrega || pedido.horarioEntrega || 'A convenir';
            const metodo = pedido.metodo_pago || pedido.metodoPago || 'No especificado';
            const notas = pedido.notas || '';

            let items = [];
            if (Array.isArray(pedido.items)) {
                items = pedido.items;
            } else if (typeof pedido.items === 'string') {
                try { items = JSON.parse(pedido.items); } catch {}
            }

            const fmtDinero = n => `$ ${Number(n || 0).toLocaleString('es-AR')}`;

            let msg = `🛒 *¡NUEVO PEDIDO RECIBIDO!*\n`;
            msg += `━━━━━━━━━━━━━━━━━━━━\n`;
            msg += `• Pedido: *${numero}*\n`;
            msg += `• Cliente: *${cliente}*\n`;
            msg += `• Total: *${fmtDinero(total)}*\n`;
            if (telefono) msg += `• Teléfono: ${telefono}\n`;
            if (direccion) msg += `• Entrega: ${direccion}${zona ? ` (${zona})` : ''}\n`;
            msg += `• Horario: ${horario}\n`;
            msg += `• Pago: ${metodo}\n`;

            if (items.length > 0) {
                msg += `\n📦 *Productos (${items.length}):*\n`;
                items.slice(0, 6).forEach(it => {
                    const cant = it.cantidad || 1;
                    const nom = it.nombre || it.producto_nombre || 'Producto';
                    const sub = Number(it.subtotal) || (cant * (Number(it.precio_unitario) || 0));
                    msg += `  • ${cant}x ${nom} (${fmtDinero(sub)})\n`;
                });
                if (items.length > 6) {
                    msg += `  • ... y ${items.length - 6} ítems más\n`;
                }
            }

            if (notas) {
                msg += `\n📝 *Notas:* ${notas}\n`;
            }
            msg += `━━━━━━━━━━━━━━━━━━━━\n`;
            msg += `👉 _Entrá a la base de gestión para generar el remito_`;

            // 1. Notificación interna en el sistema
            await this.registrarNotificacion({
                tipo: 'pedido_web',
                titulo: `🛒 Nuevo Pedido Web: ${numero} (${cliente})`,
                mensaje: `Total: ${fmtDinero(total)} · Tel: ${telefono} · Dirección: ${direccion}`,
                nivel: 'info',
                referencia_tipo: 'pedido_web',
                referencia_id: pedido.id || null
            }).catch(() => {});

            // 2. Telegram Bot
            const telegramToken = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'telegram_bot_token'").catch(() => null);
            const telegramChatId = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'telegram_chat_id'").catch(() => null);

            if (telegramToken && telegramToken.valor && telegramChatId && telegramChatId.valor) {
                const url = `https://api.telegram.org/bot${telegramToken.valor}/sendMessage`;
                fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: telegramChatId.valor,
                        text: msg,
                        parse_mode: 'Markdown'
                    })
                }).catch(e => console.warn('Error Telegram pedido nuevo:', e.message));
            }

            // 3. Webhook de alertas
            const webhookUrl = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'alertas_webhook_url'").catch(() => null);
            if (webhookUrl && webhookUrl.valor) {
                fetch(webhookUrl.valor, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        evento: 'NUEVO_PEDIDO',
                        pedido: { numero, cliente, total, telefono, direccion, zona, items }
                    })
                }).catch(e => console.warn('Error Webhook pedido nuevo:', e.message));
            }

            // 4. WhatsApp CallMeBot a cada celular configurado
            const destRow = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'callmebot_destinatarios'").catch(() => null);
            let destinatarios = [];
            if (destRow && destRow.valor) {
                try { destinatarios = JSON.parse(destRow.valor); } catch {}
            }

            if (Array.isArray(destinatarios) && destinatarios.length > 0) {
                for (const d of destinatarios) {
                    const tel = String(d.telefono || '').replace(/[^0-9]/g, '');
                    const key = String(d.apikey || '').trim();
                    if (!tel || !key) continue;

                    const url = `https://api.callmebot.com/whatsapp.php?phone=${tel}&text=${encodeURIComponent(msg)}&apikey=${key}`;
                    fetch(url).catch(e => console.warn(`Error WhatsApp CallMeBot a ${tel}:`, e.message));
                }
            }
        } catch (err) {
            console.error('Error en notificarNuevoPedido:', err.message);
        }
    }
}

module.exports = AlertasService;
