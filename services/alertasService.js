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
     * Envía notificación a Telegram o WhatsApp si están configurados en configuracion_sistema
     */
    static async notificarCanalExterno(titulo, mensaje) {
        try {
            // Telegram Bot
            const telegramToken = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'telegram_bot_token'");
            const telegramChatId = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'telegram_chat_id'");

            if (telegramToken && telegramToken.valor && telegramChatId && telegramChatId.valor) {
                const text = `*Mix Point - Alerta Sistema*\n\n${titulo}\n${mensaje}`;
                const url = `https://api.telegram.org/bot${telegramToken.valor}/sendMessage`;
                await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: telegramChatId.valor,
                        text,
                        parse_mode: 'Markdown'
                    })
                });
            }

            // Webhook genérico (WhatsApp gateway, Zapier, Make, etc.)
            const webhookUrl = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'alertas_webhook_url'");
            if (webhookUrl && webhookUrl.valor) {
                await fetch(webhookUrl.valor, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        origen: 'Mix Point Alertas',
                        titulo,
                        mensaje,
                        timestamp: new Date().toISOString()
                    })
                });
            }
        } catch (err) {
            console.warn('Alerta externa no enviada:', err.message);
        }
    }
}

module.exports = AlertasService;
