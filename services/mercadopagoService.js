const db = require('../db/pool');
const ConciliacionService = require('./conciliacionService');
const { emitirEventoDeposito } = require('../socket');

const MP_API_BASE = 'https://api.mercadopago.com';

const MEDIOS_PAGO_LABELS = {
    bank_transfer: 'Transferencia CVU/CBU',
    account_money: 'Dinero en cuenta MP',
    debit_card: 'Tarjeta de Débito',
    credit_card: 'Tarjeta de Crédito',
    prepaid_card: 'Tarjeta Prepaga',
    ticket: 'Efectivo / Rapipago / Pago Fácil'
};

function enmascararToken(token) {
    if (!token) return '';
    const str = String(token).trim();
    if (str.length <= 12) return '****';
    return `${str.slice(0, 8)}****${str.slice(-6)}`;
}

function formatearFechaHoraArgentina(isoDate) {
    if (!isoDate) {
        const now = new Date();
        return {
            fecha_movimiento: new Intl.DateTimeFormat('en-CA', {
                timeZone: 'America/Argentina/Buenos_Aires',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            }).format(now),
            hora_ar: new Intl.DateTimeFormat('es-AR', {
                timeZone: 'America/Argentina/Buenos_Aires',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            }).format(now)
        };
    }

    const d = new Date(isoDate);
    if (isNaN(d.getTime())) {
        return { fecha_movimiento: String(isoDate).slice(0, 10), hora_ar: '' };
    }

    const fecha_movimiento = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Argentina/Buenos_Aires',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(d);

    const hora_ar = new Intl.DateTimeFormat('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).format(d);

    return { fecha_movimiento, hora_ar };
}

function mapearPagoMP(p) {
    const fechaBase = p.date_approved || p.date_created;
    const { fecha_movimiento, hora_ar } = formatearFechaHoraArgentina(fechaBase);

    const nombrePayer = [p.payer?.first_name, p.payer?.last_name]
        .filter(Boolean)
        .join(' ')
        .trim();
    const nombreAlt = [p.additional_info?.payer?.first_name, p.additional_info?.payer?.last_name]
        .filter(Boolean)
        .join(' ')
        .trim();
    const titular = nombrePayer || nombreAlt || p.payer?.email || 'Cliente Mercado Pago';

    const medioPago = MEDIOS_PAGO_LABELS[p.payment_type_id]
        || p.payment_method_id
        || p.payment_type_id
        || 'Mercado Pago';

    return {
        id: String(p.id),
        fecha_aprobacion: fechaBase,
        fecha_movimiento,
        hora_ar,
        monto: Number(p.transaction_amount) || 0,
        monto_neto: Number(p.transaction_details?.net_received_amount ?? p.transaction_amount) || 0,
        medio_pago: medioPago,
        payment_type_id: p.payment_type_id || '',
        payment_method_id: p.payment_method_id || '',
        titular,
        cuit: p.payer?.identification?.number ? String(p.payer.identification.number) : '',
        descripcion: p.description || p.external_reference || `Cobro ${medioPago}`,
        external_reference: p.external_reference || '',
        estado: p.status || 'approved'
    };
}

async function setConfigValue(clave, valor) {
    await db.run(`
        INSERT INTO configuracion_sistema (clave, valor, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()
    `, [clave, String(valor ?? '')]);
}

class MercadoPagoService {
    static async obtenerConfig({ incluirToken = false } = {}) {
        const rows = await db.all(`
            SELECT clave, valor
            FROM configuracion_sistema
            WHERE clave IN (
                'mercadopago_access_token',
                'mercadopago_user_id',
                'mercadopago_cuenta_info',
                'mercadopago_auto_sync',
                'mercadopago_ultimo_sync'
            )
        `);
        const map = {};
        rows.forEach(r => { map[r.clave] = r.valor; });

        const rawToken = (map.mercadopago_access_token || '').trim();
        let cuentaInfo = null;
        if (map.mercadopago_cuenta_info) {
            try { cuentaInfo = JSON.parse(map.mercadopago_cuenta_info); } catch {}
        }

        const result = {
            configurado: Boolean(rawToken),
            token_enmascarado: enmascararToken(rawToken),
            user_id: map.mercadopago_user_id || '',
            cuenta_info: cuentaInfo,
            auto_sync: map.mercadopago_auto_sync !== 'false',
            ultimo_sync: map.mercadopago_ultimo_sync || null
        };

        if (incluirToken) {
            result.access_token = rawToken;
        }

        return result;
    }

    static async guardarConfig({ access_token, auto_sync, limpiar_token = false } = {}) {
        if (limpiar_token) {
            await setConfigValue('mercadopago_access_token', '');
            await setConfigValue('mercadopago_user_id', '');
            await setConfigValue('mercadopago_cuenta_info', '');
        } else if (access_token !== undefined) {
            const tokenLimpio = String(access_token).trim();
            if (tokenLimpio && !tokenLimpio.includes('****')) {
                await setConfigValue('mercadopago_access_token', tokenLimpio);
                await setConfigValue('mercadopago_user_id', '');
                await setConfigValue('mercadopago_cuenta_info', '');
            }
        }

        if (auto_sync !== undefined) {
            await setConfigValue('mercadopago_auto_sync', auto_sync ? 'true' : 'false');
        }

        return this.obtenerConfig({ incluirToken: false });
    }

    static async probarConexion(tokenOpcional = null) {
        let token = tokenOpcional ? String(tokenOpcional).trim() : '';
        if (!token || token.includes('****')) {
            const cfg = await this.obtenerConfig({ incluirToken: true });
            token = cfg.access_token;
        }

        if (!token) {
            return { ok: false, error: 'No hay Access Token de Mercado Pago configurado.' };
        }

        try {
            const res = await fetch(`${MP_API_BASE}/users/me`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json'
                }
            });

            if (!res.ok) {
                const errBody = await res.json().catch(() => ({}));
                const msg = errBody.message || `Mercado Pago respondió HTTP ${res.status}`;
                return { ok: false, error: msg };
            }

            const data = await res.json();
            const cuenta = {
                id: String(data.id),
                nickname: data.nickname || '',
                email: data.email || '',
                nombre: [data.first_name, data.last_name].filter(Boolean).join(' ').trim()
            };

            await setConfigValue('mercadopago_user_id', cuenta.id);
            await setConfigValue('mercadopago_cuenta_info', JSON.stringify(cuenta));

            return { ok: true, cuenta };
        } catch (err) {
            return { ok: false, error: err.message || 'Error conectando con Mercado Pago.' };
        }
    }

    static async obtenerPagosRecientes({ horas = 24, limite = 30 } = {}) {
        const cfg = await this.obtenerConfig({ incluirToken: true });
        if (!cfg.access_token) {
            return {
                configurado: false,
                pagos: [],
                ultimo_sync: cfg.ultimo_sync,
                cuenta_info: cfg.cuenta_info
            };
        }

        let userId = cfg.user_id;
        if (!userId) {
            const prueba = await this.probarConexion(cfg.access_token);
            if (prueba.ok && prueba.cuenta?.id) {
                userId = prueba.cuenta.id;
            }
        }

        const ahora = new Date();
        const desde = new Date(ahora.getTime() - (Number(horas) || 24) * 60 * 60 * 1000);
        const beginStr = desde.toISOString();
        const endStr = ahora.toISOString();
        const maxLim = Math.min(Math.max(Number(limite) || 30, 1), 100);

        const params = new URLSearchParams({
            sort: 'date_created',
            criteria: 'desc',
            status: 'approved',
            range: 'date_created',
            begin_date: beginStr,
            end_date: endStr,
            limit: String(maxLim)
        });

        const res = await fetch(`${MP_API_BASE}/v1/payments/search?${params.toString()}`, {
            headers: {
                Authorization: `Bearer ${cfg.access_token}`,
                Accept: 'application/json'
            }
        });

        if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            throw new Error(errBody.message || `Error consultando pagos en Mercado Pago (HTTP ${res.status})`);
        }

        const data = await res.json();
        const rawResults = Array.isArray(data.results) ? data.results : [];

        // Filtrar únicamente cobros entrantes positivos hacia la cuenta de Mix Point
        const entrantes = rawResults.filter(p => {
            if (Number(p.transaction_amount) <= 0) return false;
            if (userId && p.collector_id && Number(p.collector_id) !== Number(userId)) return false;
            return true;
        });

        const pagos = entrantes.map(mapearPagoMP).sort((a, b) => {
            return new Date(b.fecha_aprobacion || 0).getTime() - new Date(a.fecha_aprobacion || 0).getTime();
        });

        // Cruzar estado contra conciliaciones_bancarias
        const idsStr = pagos.map(p => p.id);
        const conciliadosMap = {};
        if (idsStr.length > 0) {
            const rows = await db.all(`
                SELECT cb.id, cb.comprobante_nro, cb.estado, cb.remito_id, cb.cliente_id, r.numero as remito_numero
                FROM conciliaciones_bancarias cb
                LEFT JOIN remitos r ON r.id = cb.remito_id
                WHERE cb.cuenta_origen = 'mercadopago' AND cb.comprobante_nro = ANY($1)
            `, [idsStr]);
            rows.forEach(r => { conciliadosMap[String(r.comprobante_nro)] = r; });
        }

        const pagosConEstado = pagos.map(p => {
            const c = conciliadosMap[p.id];
            return {
                ...p,
                ya_conciliado: c?.estado === 'conciliado',
                conciliacion_id: c?.id || null,
                conciliacion_estado: c?.estado || null,
                conciliacion_remito_id: c?.remito_id || null,
                conciliacion_remito_numero: c?.remito_numero || null
            };
        });

        return {
            configurado: true,
            pagos: pagosConEstado,
            ultimo_sync: cfg.ultimo_sync,
            cuenta_info: cfg.cuenta_info
        };
    }

    static async sincronizarMovimientos({ dias = 7, silencioso = false } = {}) {
        const resp = await this.obtenerPagosRecientes({ horas: (Number(dias) || 7) * 24, limite: 60 });
        if (!resp.configurado) {
            if (silencioso) return { ok: false, configurado: false, importados: 0, total_procesados: 0 };
            throw new Error('Mercado Pago no está configurado. Cargá tu Access Token primero.');
        }

        const movimientos = resp.pagos.map(p => ({
            fecha_movimiento: p.fecha_movimiento,
            monto: p.monto,
            descripcion: `${p.descripcion} (${p.medio_pago})${p.external_reference ? ` · Ref: ${p.external_reference}` : ''}`,
            comprobante_nro: p.id,
            titular: p.titular,
            cuit: p.cuit
        }));

        const resultado = movimientos.length > 0
            ? await ConciliacionService.importarYCruzar(movimientos, 'mercadopago')
            : { total_procesados: 0, importados: 0, items: [] };

        const ahoraIso = new Date().toISOString();
        await setConfigValue('mercadopago_ultimo_sync', ahoraIso);

        if (resultado.importados > 0) {
            emitirEventoDeposito('pago_mercadopago_recibido', {
                importados: resultado.importados,
                items: resultado.items
            });
        }

        return {
            ok: true,
            total_api: resp.pagos.length,
            total_procesados: resultado.total_procesados,
            importados: resultado.importados,
            items: resultado.items,
            ultimo_sync: ahoraIso
        };
    }

    static async procesarWebhook(body = {}, query = {}) {
        const topic = String(body?.type || body?.topic || query?.topic || body?.action || '').toLowerCase();
        const paymentId = body?.data?.id || query?.['data.id'] || query?.id || '';

        if (!topic.includes('payment') || !paymentId) {
            return { ok: true, ignorado: true };
        }

        const cfg = await this.obtenerConfig({ incluirToken: true });
        if (!cfg.access_token) {
            return { ok: true, ignorado: true, motivo: 'Sin token configurado' };
        }

        const res = await fetch(`${MP_API_BASE}/v1/payments/${encodeURIComponent(String(paymentId))}`, {
            headers: {
                Authorization: `Bearer ${cfg.access_token}`,
                Accept: 'application/json'
            }
        });

        if (!res.ok) {
            return { ok: false, error: `Error consultando pago ${paymentId}: HTTP ${res.status}` };
        }

        const p = await res.json();
        if (p.status !== 'approved' || Number(p.transaction_amount) <= 0) {
            return { ok: true, ignorado: true, estado: p.status };
        }
        if (cfg.user_id && p.collector_id && Number(p.collector_id) !== Number(cfg.user_id)) {
            return { ok: true, ignorado: true, motivo: 'Pago saliente' };
        }

        const mapped = mapearPagoMP(p);
        const resultado = await ConciliacionService.importarYCruzar([{
            fecha_movimiento: mapped.fecha_movimiento,
            monto: mapped.monto,
            descripcion: `${mapped.descripcion} (${mapped.medio_pago})`,
            comprobante_nro: mapped.id,
            titular: mapped.titular,
            cuit: mapped.cuit
        }], 'mercadopago');

        const ahoraIso = new Date().toISOString();
        await setConfigValue('mercadopago_ultimo_sync', ahoraIso);

        // Si el cobro proviene de un Link de Pago / QR generado para un remito específico, auto-conciliar al instante
        let remitoIdMatch = p.metadata?.remito_id ? Number(p.metadata.remito_id) : null;
        if (!remitoIdMatch && mapped.external_reference) {
            const matchRef = String(mapped.external_reference).match(/^REMITO-(\d+)\|/i);
            if (matchRef) remitoIdMatch = Number(matchRef[1]);
        }

        let autoConciliado = false;
        if (remitoIdMatch) {
            try {
                await this.confirmarPagoEnRemito({
                    remito_id: remitoIdMatch,
                    payment: mapped,
                    usuario_id: null
                });
                autoConciliado = true;
            } catch (errAuto) {
                console.warn('[MercadoPago Webhook] No se pudo auto-conciliar remito:', errAuto.message);
            }
        }

        emitirEventoDeposito('pago_mercadopago_recibido', {
            importados: resultado.importados,
            auto_conciliado: autoConciliado,
            remito_id: remitoIdMatch,
            payment: mapped
        });

        return { ok: true, importados: resultado.importados, auto_conciliado: autoConciliado, payment: mapped };
    }

    static async crearLinkPagoRemito({ remito_id, backend_url = '' } = {}) {
        const remitoIdNum = Number(remito_id);
        if (!remitoIdNum) {
            throw new Error('ID de remito inválido.');
        }

        const cfg = await this.obtenerConfig({ incluirToken: true });
        if (!cfg.access_token) {
            throw new Error('Mercado Pago no está configurado. Cargá tu Access Token en Conciliación Bancaria primero.');
        }

        const remito = await db.one(`
            SELECT r.*, c.razon_social, c.email
            FROM remitos r
            JOIN clientes c ON c.id = r.cliente_id
            WHERE r.id = $1
        `, [remitoIdNum]);

        if (!remito) {
            throw new Error('Remito no encontrado.');
        }

        const total = Number(remito.total) || 0;
        if (total <= 0) {
            throw new Error('El remito debe tener un total mayor a $0 para generar un link de pago.');
        }

        const cleanBackend = String(backend_url || '').replace(/\/+$/, '');
        const preferenceBody = {
            items: [
                {
                    title: `Pedido Mix Point ${remito.numero} (${remito.razon_social})`,
                    quantity: 1,
                    currency_id: 'ARS',
                    unit_price: Number(total.toFixed(2))
                }
            ],
            external_reference: `REMITO-${remito.id}|${remito.numero}`,
            statement_descriptor: 'MIX POINT',
            metadata: {
                remito_id: remito.id,
                remito_numero: remito.numero,
                cliente_id: remito.cliente_id
            }
        };

        if (remito.email && String(remito.email).includes('@')) {
            preferenceBody.payer = {
                name: remito.razon_social,
                email: String(remito.email).trim()
            };
        }

        if (cleanBackend.startsWith('https://')) {
            preferenceBody.notification_url = `${cleanBackend}/api/mercadopago/webhook`;
        }

        const res = await fetch(`${MP_API_BASE}/checkout/preferences`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${cfg.access_token}`,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify(preferenceBody)
        });

        if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            throw new Error(errBody.message || `Mercado Pago respondió HTTP ${res.status} al crear el link.`);
        }

        const pref = await res.json();
        const linkMeta = {
            mp_link_pago: pref.init_point,
            mp_preference_id: pref.id,
            mp_link_generado_at: new Date().toISOString()
        };

        await db.run(`
            UPDATE remitos
            SET datos_despacho = COALESCE(datos_despacho, '{}'::jsonb) || $1::jsonb
            WHERE id = $2
        `, [JSON.stringify(linkMeta), remito.id]);

        emitirEventoDeposito('remito:editado', {
            id: remito.id,
            numero: remito.numero
        });

        return {
            ok: true,
            init_point: pref.init_point,
            preference_id: pref.id,
            remito_id: remito.id,
            remito_numero: remito.numero,
            total
        };
    }

    static async confirmarPagoEnRemito({ remito_id, payment, usuario_id = null }) {
        const remitoIdNum = Number(remito_id);
        if (!remitoIdNum || !payment || !payment.id) {
            throw new Error('Datos insuficientes para confirmar el pago del remito.');
        }

        const remito = await db.one('SELECT id, numero, cliente_id, total, estado_pago FROM remitos WHERE id = $1', [remitoIdNum]);
        if (!remito) {
            throw new Error('Remito no encontrado.');
        }

        const comprobanteNro = String(payment.id);
        let movConc = await db.one(
            `SELECT * FROM conciliaciones_bancarias WHERE comprobante_nro = $1 AND cuenta_origen = 'mercadopago'`,
            [comprobanteNro]
        );

        if (movConc && movConc.estado === 'conciliado') {
            if (movConc.remito_id && Number(movConc.remito_id) !== remito.id) {
                throw new Error(`El pago MP #${comprobanteNro} ya fue conciliado en otro remito.`);
            }
            // Asegurar estado_pago consistente
            await db.run(`UPDATE remitos SET estado_pago = 'pagado' WHERE id = $1`, [remito.id]);
            return { ok: true, remito_id: remito.id, payment_id: comprobanteNro, ya_estaba_conciliado: true };
        }

        const monto = Number(payment.monto || payment.transaction_amount || 0);
        if (monto <= 0) {
            throw new Error('El monto del pago debe ser mayor a 0.');
        }

        const fechaMov = payment.fecha_movimiento || formatearFechaHoraArgentina().fecha_movimiento;
        const obs = `Pago verificado en vivo vía API Mercado Pago (Op #${comprobanteNro}${payment.titular ? ` · ${payment.titular}` : ''})`;

        if (!movConc) {
            const { row } = await db.run(`
                INSERT INTO conciliaciones_bancarias (
                    fecha_movimiento, cuenta_origen, descripcion, monto, comprobante_nro,
                    titular, cuit, remito_id, cliente_id, estado, diferencia, observaciones
                ) VALUES ($1, 'mercadopago', $2, $3, $4, $5, $6, $7, $8, 'pendiente', $9, $10)
                RETURNING *
            `, [
                fechaMov,
                payment.descripcion || `Cobro Mercado Pago (${payment.medio_pago || 'MP'})`,
                monto,
                comprobanteNro,
                payment.titular || null,
                payment.cuit || null,
                remito.id,
                remito.cliente_id,
                monto - Number(remito.total || 0),
                obs
            ]);
            movConc = row;
        }

        await ConciliacionService.conciliar({
            conciliacion_id: movConc.id,
            cliente_id: remito.cliente_id,
            remito_id: remito.id,
            observaciones: obs,
            usuario_id
        });

        emitirEventoDeposito('remito:pago_cambiado', {
            id: remito.id,
            numero: remito.numero,
            estado_pago: 'pagado'
        });
        emitirEventoDeposito('remito:editado', {
            id: remito.id,
            numero: remito.numero
        });
        emitirEventoDeposito('pago_mercadopago_recibido', {
            remito_id: remito.id,
            payment_id: comprobanteNro
        });

        return { ok: true, remito_id: remito.id, payment_id: comprobanteNro };
    }
}

module.exports = MercadoPagoService;
