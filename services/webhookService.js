class WebhookService {
    /**
     * Envía una notificación HTTP POST a un webhook externo (Make, Zapier, n8n, WhatsApp API)
     * Utiliza fetch nativo de Node.js
     * @param {Object} options
     * @param {string} options.evento Nombre del evento (ej: 'REMITO_DESPACHADO', 'ALERTA_STOCK', 'REPORTE_DIARIO')
     * @param {Object} options.datos Datos asociados al evento
     * @param {string} [options.url] URL opcional de webhook que sobreescribe la variable de entorno
     */
    static async disparar({ evento, datos, url = null }) {
        const webhookUrl = url || process.env.WEBHOOK_NOTIFICATION_URL || process.env.WHATSAPP_WEBHOOK_URL;
        if (!webhookUrl) {
            // Si no está configurada, no falla: registra en consola de manera limpia
            console.log(`[WebhookService] Disparo simulado (sin URL configurada): [${evento}]`, {
                itemsCount: datos?.items?.length || 0,
                numero: datos?.numero || datos?.id
            });
            return { ok: true, simulado: true };
        }

        const payload = {
            sistema: 'Mix Point Mayorista',
            ambiente: process.env.NODE_ENV || 'production',
            timestamp: new Date().toISOString(),
            evento,
            datos
        };

        try {
            const respuesta = await fetch(webhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'MixPoint-WebhookService/1.0'
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(8000)
            });

            console.log(`🚀 [WebhookService] Evento "${evento}" enviado exitosamente a webhook. Status: ${respuesta.status}`);
            return { ok: true, status: respuesta.status };
        } catch (err) {
            console.error(`⚠️ [WebhookService] Error al disparar webhook para "${evento}":`, err.message);
            return { ok: false, error: err.message };
        }
    }

    /**
     * Notifica el cambio de estado de un pedido/remito
     */
    static async notificarCambioRemito(remito, accion = 'ACTUALIZADO') {
        return this.disparar({
            evento: `REMITO_${accion.toUpperCase()}`,
            datos: {
                id: remito.id,
                numero: remito.numero,
                cliente_id: remito.cliente_id,
                cliente_nombre: remito.cliente_nombre,
                cliente_telefono: remito.cliente_telefono,
                total: remito.total,
                estado: remito.estado,
                transportista: remito.transportista,
                bultos: remito.bultos,
                peso_kg: remito.peso_kg
            }
        });
    }
}

module.exports = WebhookService;
