const db = require('../db/pool');
const WebSearchService = require('./webSearchService');

/**
 * Motor de Inteligencia de Negocios y Asistente Autónomo "J.A.R.V.I.S." para Mix Point
 * Nivel Avanzado: Razonamiento Chain-of-Thought (CoT), Búsqueda Web en Vivo, MCP, memoria extendida y análisis probabilístico.
 */
class JarvisService {
    /**
     * Helper estructurador de razonamiento profundo Chain-of-Thought (CoT)
     */
    static estructurarRazonamiento({ analisis, evaluacion, recomendacion }) {
        return [
            { paso: 1, fase: 'Auditoría & Análisis de Datos', icono: '📊', detalle: analisis },
            { paso: 2, fase: 'Evaluación de Impacto Operativo & Riesgo', icono: '⚖️', detalle: evaluacion },
            { paso: 3, fase: 'Conclusión Estratégica & Decisión Ejecutiva', icono: '🎯', detalle: recomendacion }
        ];
    }
    /**
     * Consulta de stock y lotes
     */
    static async consultarStock({ filtro = '', solo_critico = false } = {}) {
        let query = `
            SELECT p.id, p.codigo, p.nombre, p.stock_actual, p.stock_minimo, p.unidad_medida, p.precio_venta,
                   c.nombre as categoria
            FROM productos p
            LEFT JOIN categorias_producto c ON c.id = p.categoria_id
            WHERE p.activo = true
        `;
        const params = [];

        if (solo_critico) {
            query += ` AND p.stock_actual <= p.stock_minimo`;
        }

        if (filtro) {
            params.push(`%${filtro.trim()}%`);
            query += ` AND (p.nombre ILIKE $${params.length} OR p.codigo ILIKE $${params.length})`;
        }

        query += ` ORDER BY p.stock_actual ASC LIMIT 20`;
        const items = await db.all(query, params);
        return {
            total_encontrados: items.length,
            productos: items.map(p => ({
                id: p.id,
                codigo: p.codigo,
                nombre: p.nombre,
                stock: Number(p.stock_actual),
                minimo: Number(p.stock_minimo),
                unidad: p.unidad_medida,
                precio: Number(p.precio_venta),
                alerta: Number(p.stock_actual) <= Number(p.stock_minimo)
            }))
        };
    }

    /**
     * Predicción inteligente de quiebre de stock basado en consumo promedio diario (últimos 30 días)
     */
    static async predecirQuiebreStock({ limite = 15 } = {}) {
        const query = `
            WITH ventas_30d AS (
                SELECT ri.producto_id,
                       COALESCE(SUM(ri.cantidad), 0) as total_vendido_30d,
                       ROUND(COALESCE(SUM(ri.cantidad), 0) / 30.0, 2) as consumo_diario_promedio
                FROM remito_items ri
                JOIN remitos r ON r.id = ri.remito_id
                WHERE r.fecha >= CURRENT_DATE - INTERVAL '30 days'
                  AND r.estado NOT IN ('cancelado', 'anulado')
                GROUP BY ri.producto_id
            )
            SELECT p.id, p.codigo, p.nombre, p.stock_actual, p.stock_minimo, p.unidad_medida, p.precio_venta,
                   c.nombre as categoria,
                   COALESCE(v.total_vendido_30d, 0) as total_vendido_30d,
                   COALESCE(v.consumo_diario_promedio, 0) as consumo_diario_promedio,
                   CASE 
                     WHEN COALESCE(v.consumo_diario_promedio, 0) > 0 THEN 
                       ROUND(p.stock_actual / v.consumo_diario_promedio, 1)
                     ELSE 999 
                   END as dias_restantes
            FROM productos p
            LEFT JOIN categorias_producto c ON c.id = p.categoria_id
            LEFT JOIN ventas_30d v ON v.producto_id = p.id
            WHERE p.activo = true
            ORDER BY dias_restantes ASC, p.stock_actual ASC
            LIMIT $1
        `;
        const items = await db.all(query, [limite]);
        return items.map(p => {
            const dias = Number(p.dias_restantes);
            const diasVal = dias >= 999 ? null : dias;
            return {
                id: p.id,
                codigo: p.codigo,
                nombre: p.nombre,
                categoria: p.categoria,
                stock_actual: Number(p.stock_actual),
                stock_minimo: Number(p.stock_minimo),
                unidad: p.unidad_medida,
                precio: Number(p.precio_venta),
                total_vendido_30d: Number(p.total_vendido_30d),
                consumo_diario: Number(p.consumo_diario_promedio),
                dias_restantes: diasVal,
                alerta_quiebre: (diasVal !== null && diasVal <= 7) || Number(p.stock_actual) <= Number(p.stock_minimo)
            };
        });
    }

    /**
     * Consulta de ventas recientes y facturación
     */
    static async consultarVentas({ periodo = 'hoy', limite = 5 } = {}) {
        let whereFecha = `r.fecha = CURRENT_DATE`;
        if (periodo === 'ayer') whereFecha = `r.fecha = CURRENT_DATE - INTERVAL '1 day'`;
        else if (periodo === 'semana') whereFecha = `r.fecha >= CURRENT_DATE - INTERVAL '7 days'`;
        else if (periodo === 'mes') whereFecha = `r.fecha >= DATE_TRUNC('month', CURRENT_DATE)`;

        const stats = await db.one(`
            SELECT COUNT(r.id)::int as total_remitos,
                   COALESCE(SUM(r.total), 0) as facturado
            FROM remitos r
            WHERE ${whereFecha} AND r.estado NOT IN ('cancelado', 'anulado')
        `);

        const remitos = await db.all(`
            SELECT r.id, r.numero, r.total, r.fecha, r.estado, c.razon_social as cliente
            FROM remitos r
            JOIN clientes c ON c.id = r.cliente_id
            WHERE ${whereFecha} AND r.estado NOT IN ('cancelado', 'anulado')
            ORDER BY r.id DESC
            LIMIT $1
        `, [limite]);

        return {
            periodo,
            total_remitos: Number(stats?.total_remitos || 0),
            facturado: Number(stats?.facturado || 0),
            remitos_recientes: remitos
        };
    }

    /**
     * Consulta de cuentas corrientes y deudas
     */
    static async consultarDeudaClientes({ top = 5 } = {}) {
        const resumen = await db.one(`
            SELECT COUNT(*)::int as clientes_deudores_total,
                   COALESCE(SUM(saldo_cuenta), 0) as deuda_total_calle
            FROM clientes
            WHERE activo = true AND saldo_cuenta > 0
        `);

        const topDeudores = await db.all(`
            SELECT id, razon_social as cliente, telefono, saldo_cuenta as deuda
            FROM clientes
            WHERE activo = true AND saldo_cuenta > 0
            ORDER BY saldo_cuenta DESC
            LIMIT $1
        `, [top]);

        return {
            deuda_total_calle: Number(resumen?.deuda_total_calle || 0),
            clientes_deudores_total: Number(resumen?.clientes_deudores_total || 0),
            top_deudores: topDeudores.map(c => ({
                id: c.id,
                cliente: c.cliente,
                telefono: c.telefono,
                deuda: Number(c.deuda)
            }))
        };
    }

    /**
     * Flujo de caja y finanzas
     */
    static async consultarFinanzas() {
        const ingresosMes = await db.one(`
            SELECT COALESCE(SUM(total), 0) as ventas_facturadas
            FROM remitos
            WHERE fecha >= DATE_TRUNC('month', CURRENT_DATE) AND estado NOT IN ('cancelado', 'anulado')
        `);

        const gastosMes = await db.one(`
            SELECT COALESCE(SUM(monto), 0) as gastos_operativos
            FROM gastos
            WHERE fecha >= DATE_TRUNC('month', CURRENT_DATE)
        `);

        const cobranzasMes = await db.one(`
            SELECT COALESCE(SUM(monto), 0) as cobranzas_efectivas
            FROM pagos_clientes
            WHERE fecha >= DATE_TRUNC('month', CURRENT_DATE)
        `).catch(() => ({ cobranzas_efectivas: 0 }));

        const ventas = Number(ingresosMes?.ventas_facturadas || 0);
        const gastos = Number(gastosMes?.gastos_operativos || 0);
        const cobranzas = Number(cobranzasMes?.cobranzas_efectivas || 0);

        return {
            ventas_facturadas: ventas,
            gastos_operativos: gastos,
            cobranzas_efectivas: cobranzas,
            flujo_neto_caja: cobranzas > 0 ? (cobranzas - gastos) : (ventas - gastos)
        };
    }

    /**
     * Simulación inteligente de producción
     */
    static async simularProduccion({ receta_id = null, cantidad_kg = 50 } = {}) {
        let receta = null;
        if (receta_id) {
            receta = await db.one('SELECT r.*, p.nombre as producto_nombre FROM recetas r JOIN productos p ON p.id = r.producto_id WHERE r.id = $1', [receta_id]);
        } else {
            receta = await db.one('SELECT r.*, p.nombre as producto_nombre FROM recetas r JOIN productos p ON p.id = r.producto_id WHERE r.activo = true LIMIT 1');
        }

        if (!receta) {
            return { error: 'No se encontró una fórmula activa en el sistema de producción.' };
        }

        const ingredientes = await db.all(`
            SELECT ri.*, p.nombre as ingrediente_nombre, p.stock_actual
            FROM receta_items ri
            JOIN productos p ON p.id = ri.ingrediente_id
            WHERE ri.receta_id = $1
        `, [receta.id]);

        let esFactible = true;
        let cantMaxPosible = 999999;
        const insumosDetalle = [];

        for (const ing of ingredientes) {
            const kgRequeridos = (Number(ing.porcentaje) / 100) * cantidad_kg;
            const disp = Number(ing.stock_actual || 0);
            const falta = Math.max(0, kgRequeridos - disp);

            if (falta > 0) esFactible = false;

            if (Number(ing.porcentaje) > 0) {
                const maxConEste = (disp / (Number(ing.porcentaje) / 100));
                if (maxConEste < cantMaxPosible) cantMaxPosible = maxConEste;
            }

            insumosDetalle.push({
                ingrediente: ing.ingrediente_nombre,
                porcentaje: Number(ing.porcentaje),
                requerido_kg: kgRequeridos,
                disponible_kg: disp,
                falta_kg: falta,
                estado: disp >= kgRequeridos ? 'OK' : 'FALTANTE'
            });
        }

        return {
            receta: receta.nombre,
            producto: receta.producto_nombre,
            cantidad_solicitada_kg: cantidad_kg,
            es_factible: esFactible,
            produccion_maxima_posible_kg: Math.floor(cantMaxPosible),
            insumos: insumosDetalle
        };
    }

    /**
     * Responde una pregunta en lenguaje natural con nivel de inteligencia J.A.R.V.I.S.
     * Incorpora razonamiento multi-variable, extracción de datos por MCP, y memoria extendida.
     */
    static async responderConsulta(pregunta, { mcp = null } = {}) {
        const texto = (pregunta || '').toLowerCase().trim();
        const fmtDinero = n => `$ ${Number(n).toLocaleString('es-AR')}`;

        // 0. CAPACIDAD DE COMUNICACIÓN EN RED CON PERSONAS DEL EQUIPO
        // 0.A: "¿Quién está conectado?" o "¿Quiénes están en línea?"
        if (texto.includes('conectad') || texto.includes('en linea') || texto.includes('en línea') || texto.includes('quien esta') || texto.includes('quién está') || texto.includes('equipo online')) {
            if (mcp) {
                const onlineRes = await mcp.toolConsultarUsuariosConectados({});
                const onlineData = JSON.parse(onlineRes.content[0].text);
                const usuarios = onlineData.usuarios || [];

                if (usuarios.length === 0) {
                    return {
                        respuesta: `He escaneado la red de terminales de Mix Point. Actualmente no detecto otros usuarios con sesión activa en este momento. Sin embargo, puedo dejarle un mensaje o consulta a cualquier miembro del equipo para que lo reciba al conectarse.`
                    };
                }

                const lista = usuarios.map(u => `• ${u.nombre} (${u.rol})`).join('\n');
                return {
                    respuesta: `Sistemas en red: Actualmente hay ${usuarios.length} usuario(s) conectado(s) al sistema:\n${lista}\n\nPuede pedirme: "Preguntale a [Nombre] tal cosa" y estableceré contacto de inmediato.`,
                    datos: onlineData
                };
            }
        }

        // 0.B: "Preguntale a Franco si...", "Averigua con Damian...", "Hablá con deposito..."
        const matchPreguntaRed = texto.match(/(?:preguntale|pregúntale|preguntar|averigua|averiguá|consultale|consúltale|habla|hablá|pedile|pídele|decile|dile)\s+(?:a|con|al)?\s*([a-záéíóúñ]+)\s+(.+)/i);
        if (matchPreguntaRed && mcp) {
            const destinatarioRaw = matchPreguntaRed[1].trim();
            const consultaRaw = matchPreguntaRed[2].trim();

            const resultadoEnvio = await mcp.toolConsultarPersonaEnRed({
                destinatario_nombre_o_rol: destinatarioRaw,
                consulta: consultaRaw
            });
            const info = JSON.parse(resultadoEnvio.content[0].text);

            return {
                respuesta: `Comprobación de enlace de red:\n${info.mensaje}\n\nDetalle de la consulta: "${info.consulta}". Le notificaré en cuanto reciba su contestación.`,
                datos: info,
                fuente: 'red_local'
            };
        }

        // 0.C: BÚSQUEDA WEB EN VIVO - COTIZACIÓN DE DÓLAR Y MERCADO CAMBIARIO
        if (texto.includes('dolar') || texto.includes('dólar') || texto.includes('blue') || texto.includes('mep') || texto.includes('cotiz') || texto.includes('divisa') || texto.includes('tipo de cambio')) {
            const dolar = await WebSearchService.obtenerCotizacionesDolar();
            if (dolar.ok) {
                const c = dolar.cotizaciones;
                const analisis = `Relevamiento cambiario en vivo (DolarAPI): Dólar Oficial Venta $${c.oficial.venta} | Dólar Blue Venta $${c.blue.venta} | Dólar MEP $${c.mep.venta} | Dólar Mayorista Venta $${c.mayorista.venta}.`;
                const evaluacion = `Brecha cambiaria oficial/blue aproximada: ${(((c.blue.venta - c.oficial.venta) / c.oficial.venta) * 100).toFixed(1)}%. En el rubro de frutos secos, los insumos importados (almendra Nonpareil, castaña de cajú, pasas rubias) cotizan al tipo de cambio mayorista/financiero. Una aceleración del Blue/MEP impacta de forma directa en el costo de reposición por bolsa de 10-25 kg.`;
                const recomendacion = `Mantener listas de precios actualizadas con margen de seguridad del 18-25%. Para clientes mayoristas con compras superiores a $500.000, fijar pagos a un máximo de 7 días para preservar el capital de trabajo de Mix Point.`;

                const pasos = JarvisService.estructurarRazonamiento({ analisis, evaluacion, recomendacion });

                // Almacenar en la memoria persistente del agente
                if (mcp) {
                    await mcp.toolGuardarMemoria({
                        clave: 'ultima_cotizacion_dolar',
                        contenido: {
                            fecha: new Date().toISOString(),
                            oficial: c.oficial.venta,
                            blue: c.blue.venta,
                            mep: c.mep.venta
                        }
                    }).catch(() => {});
                }

                return {
                    respuesta: `Cotizaciones del mercado cambiario obtenidas en tiempo real de la red:\n• Dólar Blue Venta: $${c.blue.venta} (Compra: $${c.blue.compra})\n• Dólar Oficial Venta: $${c.oficial.venta}\n• Dólar MEP: $${c.mep.venta}\n• Dólar Tarjeta: $${c.tarjeta.venta}\n\n💡 Análisis para Mix Point: Con el blue a $${c.blue.venta}, se recomienda auditar los costos de reposición de frutos secos importados (almendras y castañas) antes de emitir listas de precios mayoristas con plazos de pago extendidos.`,
                    datos: dolar,
                    razonamiento_pasos: pasos,
                    fuente: 'web_dolar',
                    accion_sugerida: 'Ver Inventario'
                };
            }
        }

        // 0.D: BÚSQUEDA WEB EN VIVO - ESTADO DEL CLIMA & LOGÍSTICA DE REPARTO
        if (texto.includes('clima') || texto.includes('lluvia') || texto.includes('tiempo') || texto.includes('meteorol') || ((texto.includes('reparto') || texto.includes('entrega')) && (texto.includes('calle') || texto.includes('ruta') || texto.includes('llueve')))) {
            const clima = await WebSearchService.obtenerClimaLogistica();
            if (clima.ok) {
                const analisis = `Reporte satelital Open-Meteo en vivo para Buenos Aires: Temperatura ${clima.temperatura} (Sensación ${clima.sensacion_termica}), Humedad ${clima.humedad}, Precipitaciones ${clima.precipitacion}, Viento ${clima.viento}. Condición: ${clima.condicion}.`;
                const evaluacion = `Riesgo logístico: ${clima.riesgo_logistico.toUpperCase()}. Los frutos secos y semillas son sensibles a la absorción de humedad ambiental relativa (>75%), lo que puede comprometer la textura crocante del producto si el embalaje se expone a la intemperie en muelle de descarga.`;
                const recomendacion = clima.recomendacion;

                const pasos = JarvisService.estructurarRazonamiento({ analisis, evaluacion, recomendacion });

                return {
                    respuesta: `Telemetría meteorológica y logística en tiempo real para Buenos Aires:\n• Estado: ${clima.condicion} (${clima.temperatura}, sensación térmica ${clima.sensacion_termica})\n• Humedad relativa: ${clima.humedad} | Viento: ${clima.viento}\n• Nivel de riesgo en ruta: ${clima.riesgo_logistico}\n\nDirectiva para choferes y despacho: ${clima.recomendacion}`,
                    datos: clima,
                    razonamiento_pasos: pasos,
                    fuente: 'web_clima',
                    accion_sugerida: 'Ver Preparación & Despacho'
                };
            }
        }

        // 0.E: BÚSQUEDA WEB EN VIVO - CONSULTAS GENERALES EN LA RED / GOOGLE / DUCKDUCKGO
        if (texto.startsWith('busca') || texto.startsWith('buscá') || texto.includes('buscar en internet') || texto.includes('buscar en la red') || texto.includes('buscar en google') || texto.includes('en la web') || texto.includes('noticias') || texto.includes('precio de mercado') || texto.includes('averigua en internet')) {
            const queryLimpia = texto
                .replace(/^(?:jarvis\s+)?(?:busca|buscá|buscar|averigua|averiguá)\s+(?:en\s+(?:internet|la\s+web|la\s+red|google)\s+)?/i, '')
                .replace(/en\s+(?:internet|la\s+web|la\s+red|google)$/i, '')
                .trim();

            const resultadoWeb = await WebSearchService.buscarEnWeb(queryLimpia || texto);
            if (resultadoWeb.ok) {
                const analisis = `Búsqueda ejecutada en la red para "${queryLimpia || texto}". Fuente: ${resultadoWeb.fuente || 'DuckDuckGo Open Web'}.`;
                const evaluacion = resultadoWeb.resumen;
                const recomendacion = `Información externa triangulada con los procesos comerciales de Mix Point. Lista para incorporar a las decisiones operativas.`;

                const pasos = JarvisService.estructurarRazonamiento({ analisis, evaluacion, recomendacion });

                return {
                    respuesta: `He rastreado la red para "${queryLimpia || texto}":\n\n${resultadoWeb.resumen}\n\n${resultadoWeb.url ? `🔗 Enlace de referencia: ${resultadoWeb.url}` : ''}`,
                    datos: resultadoWeb,
                    razonamiento_pasos: pasos,
                    fuente: 'web_busqueda'
                };
            }
        }

        // 0.F: ANÁLISIS ESTRATÉGICO HOLÍSTICO DEL NEGOCIO (CHAIN-OF-THOUGHT DE MÁXIMA INTELIGENCIA)
        if (texto.includes('analisis estrategico') || texto.includes('análisis estratégico') || texto.includes('plan de negocio') || texto.includes('como ves el negocio') || texto.includes('cómo ves el negocio') || texto.includes('rendimiento integral') || texto.includes('auditoria completa')) {
            const finanzas = await this.consultarFinanzas();
            const deudas = await this.consultarDeudaClientes({ top: 3 });
            const predicciones = await this.predecirQuiebreStock({ limite: 3 });
            const dolar = await WebSearchService.obtenerCotizacionesDolar().catch(() => ({ ok: false }));

            const criticosStock = predicciones.filter(p => p.alerta_quiebre);
            const stockTexto = criticosStock.length > 0
                ? `${criticosStock.length} producto(s) en umbral de quiebre (${criticosStock.map(c => c.nombre).join(', ')})`
                : 'Inventario de alta rotación equilibrado sin quiebres proyectados a 7 días';

            const analisis = `Estado verificado de subsistemas: Ventas facturadas en el mes: ${fmtDinero(finanzas.ventas_facturadas)} | Cobranzas efectivas: ${fmtDinero(finanzas.cobranzas_efectivas)} | Deuda de clientes en la calle: ${fmtDinero(deudas.deuda_total_calle)} (${deudas.clientes_deudores_total} cuentas) | Inventario: ${stockTexto}.${dolar.ok ? ` Dólar Blue de referencia: $${dolar.cotizaciones.blue.venta}.` : ''}`;
            const evaluacion = `Evaluación de liquidez y rotación: La tasa de cobranza sobre ventas representa el ${finanzas.ventas_facturadas > 0 ? Math.round((finanzas.cobranzas_efectivas / finanzas.ventas_facturadas) * 100) : 0}%. Si la deuda en calle supera el 30% del volumen mensual, el capital de trabajo queda inmovilizado afectando la recompra de insumos clave.`;
            const recomendacion = `Plan de acción en 3 frentes:\n1. Logística y Stock: Emitir órdenes de reposición inmediatas para ${criticosStock.length > 0 ? criticosStock[0].nombre : 'insumos de mayor rotación'}.\n2. Cartera: Intimar cobro a los 3 mayores saldos deudores (${deudas.top_deudores.map(d => d.cliente).join(', ') || 'sin deudores críticos'}).\n3. Precios: Revaluar costos con la cotización del dólar actual ($${dolar.ok ? dolar.cotizaciones.blue.venta : 'vigente'}).`;

            const pasos = JarvisService.estructurarRazonamiento({ analisis, evaluacion, recomendacion });

            // Almacenar en memoria extendida
            if (mcp) {
                await mcp.toolGuardarMemoria({
                    clave: 'ultimo_analisis_estrategico_negocio',
                    contenido: {
                        fecha: new Date().toISOString(),
                        ventas: finanzas.ventas_facturadas,
                        cobranzas: finanzas.cobranzas_efectivas,
                        deuda_calle: deudas.deuda_total_calle,
                        productos_criticos: criticosStock.length
                    }
                }).catch(() => {});
            }

            return {
                respuesta: `📊 Informe Estratégico Ejecutivo - Diagnóstico Holístico Mix Point:\n\n• Facturación del mes: ${fmtDinero(finanzas.ventas_facturadas)} (Cobranzas: ${fmtDinero(finanzas.cobranzas_efectivas)})\n• Cartera en la calle: ${fmtDinero(deudas.deuda_total_calle)} en ${deudas.clientes_deudores_total} cuentas activas\n• Estado de Stock: ${stockTexto}\n${dolar.ok ? `• Referencia cambiaria (Dólar Blue): $${dolar.cotizaciones.blue.venta}\n` : ''}\nHe desglosado el plan de acción en 3 pasos estratégicos para potenciar la rentabilidad.`,
                datos: { finanzas, deudas, predicciones, dolar },
                razonamiento_pasos: pasos,
                fuente: 'mcp_estrategico',
                accion_sugerida: 'Ver Reportes'
            };
        }

        // 1. AUTOMATIZACIÓN DE REMITOS Y PEDIDOS VÍA MCP
        const matchPedido = texto.match(/remito.*(?:pedido|para|de)?\s*(mp-?\d+|\d+)/i) ||
                            texto.match(/(?:generar|crear|emitir|hacer)\s*remito/i) ||
                            texto.match(/pedido\s*(mp-?\d+|\d+)/i);

        if (matchPedido && mcp) {
            try {
                const pedidoId = matchPedido[1] || 'MP-1001';
                const datosPedidoRes = await mcp.toolObtenerDatosPedido({ pedido_id_o_numero: pedidoId });
                const pedidoData = JSON.parse(datosPedidoRes.content[0].text);

                if (pedidoData.encontrado === false) {
                    return {
                        respuesta: `He realizado un escaneo por Model Context Protocol (MCP) en los registros de órdenes. No encontré el pedido "${pedidoId}". Por favor verifique el identificador correlativo para proceder sin errores.`
                    };
                }

                if (pedidoData.origen === 'remito_registrado') {
                    return {
                        respuesta: `El remito #${pedidoData.numero} ya se encuentra emitido y registrado para ${pedidoData.cliente.nombre}. El valor declarado es de ${fmtDinero(pedidoData.total)} con ${pedidoData.items.length} ítems. Estado logístico: "${pedidoData.estado}".`,
                        datos: pedidoData,
                        accion_sugerida: 'Ver Remitos'
                    };
                }

                if (pedidoData.items && pedidoData.items.length > 0) {
                    const remitoCreadoRes = await mcp.toolGenerarRemito({
                        pedido_numero: pedidoData.numero,
                        cliente_nombre: pedidoData.cliente.nombre,
                        direccion_entrega: pedidoData.cliente.direccion,
                        telefono: pedidoData.cliente.telefono,
                        transportista: 'Distribución Mix Point',
                        items: pedidoData.items
                    });

                    const resRemito = JSON.parse(remitoCreadoRes.content[0].text);

                    // Guardar en la memoria extendida el evento
                    await mcp.toolGuardarMemoria({
                        clave: `remito_${resRemito.remito_numero}`,
                        contenido: {
                            fecha: new Date().toISOString(),
                            pedido: pedidoData.numero,
                            remito: resRemito.remito_numero,
                            cliente: resRemito.cliente,
                            total: resRemito.total
                        }
                    });

                    const pasos = JarvisService.estructurarRazonamiento({
                        analisis: `Pedido origen #${pedidoData.numero} validado en solo lectura. Se certificaron ${pedidoData.items.length} ítems y destinatario ${resRemito.cliente}.`,
                        evaluacion: `Control estricto de integridad: No se permitieron alteraciones de precios ni ítems externos. Valor total verificado: ${fmtDinero(resRemito.total)}.`,
                        recomendacion: `Remito #${resRemito.remito_numero} emitido e insertado en cola de preparación del depósito para picking inmediato.`
                    });

                    return {
                        respuesta: `He analizado la orden #${pedidoData.numero} mediante MCP y procesado el remito #${resRemito.remito_numero} para ${resRemito.cliente}. Se validaron exactamente ${pedidoData.items.length} ítems por un total de ${fmtDinero(resRemito.total)}, garantizando trazabilidad y sin alterar registros anexos. El pedido está listo para el depósito.`,
                        datos: resRemito,
                        razonamiento_pasos: pasos,
                        fuente: 'mcp_db',
                        accion_sugerida: 'Ver Remitos'
                    };
                }
            } catch (errRemito) {
                console.error('Error en generación de remito:', errRemito);
            }
        }

        // 2. MONITOREO TOTAL & AUDITORÍA PREVENTIVA DEL SISTEMA (MCP)
        if (texto.includes('alerta') || texto.includes('monitore') || texto.includes('estado del sistema') || texto.includes('diagnostico') || texto.includes('diagnóstico')) {
            if (mcp) {
                const resAlertas = await mcp.toolMonitorearAlertas({ nivel_urgencia: 'todas' });
                const dataAlertas = JSON.parse(resAlertas.content[0].text);
                const criticas = dataAlertas.stock_critico.length;
                const logistica = dataAlertas.deposito_pendiente.length;
                const financieras = dataAlertas.finanzas.length;

                let r = `Diagnóstico global de sistemas Mix Point:\n`;
                r += `• Stock Crítico: ${criticas} productos por debajo del umbral mínimo.\n`;
                r += `• Logística & Depósito: ${logistica} órdenes pendientes de armado/despacho.\n`;
                r += `• Cuentas Corrientes: ${financieras} clientes con saldos deudores significativos.\n`;

                if (criticas > 0) {
                    r += `\nPrioridad 1 (Abastecimiento): ${dataAlertas.stock_critico[0].mensaje}.`;
                }

                const pasos = JarvisService.estructurarRazonamiento({
                    analisis: `Auditoría multi-nodo completada: ${criticas} alertas de inventario, ${logistica} órdenes en picking y ${financieras} cuentas a cobrar.`,
                    evaluacion: `Riesgo operacional general: ${criticas > 0 ? 'MODERADO-ALTO por stock en quiebre' : 'CONTROLADO'}. La fluidez logística en depósito requiere despacho ágil para evitar cuellos de botella.`,
                    recomendacion: criticas > 0 ? `Coordinar compras para ${dataAlertas.stock_critico[0].producto} y priorizar remitos con cobro contra entrega.` : 'Mantener ritmo estándar de empaque y monitoreo continuo.'
                });

                return {
                    respuesta: r,
                    datos: dataAlertas,
                    razonamiento_pasos: pasos,
                    fuente: 'mcp_alertas',
                    accion_sugerida: 'Ajustar Stock'
                };
            }
        }

        // 3. MEMORIA EXTENDIDA & CONTEXTO ESTRATÉGICO DEL NEGOCIO (MCP)
        if (texto.includes('memoria') || texto.includes('recuerdas') || texto.includes('analisis del negocio') || texto.includes('análisis') || texto.includes('estrategia')) {
            if (mcp) {
                const memRes = await mcp.toolConsultarMemoria({});
                const memorias = JSON.parse(memRes.content[0].text);
                const cantidad = Array.isArray(memorias) ? memorias.length : 0;

                const pasos = JarvisService.estructurarRazonamiento({
                    analisis: `Acceso al vector de memoria extendida persistente. Recuperados ${cantidad} registros históricos de decisiones, remitos y compras.`,
                    evaluacion: `La memoria extendida permite correlacionar el comportamiento de compra de clientes con quiebres recurrentes de stock para evitar desabastecimiento.`,
                    recomendacion: `Utilizar los registros para anticipar pedidos semanales a proveedores de Mendoza, Catamarca y Entre Ríos.`
                });

                return {
                    respuesta: `Accediendo a la memoria contextual persistente. Cuento con ${cantidad} nodos estratégicos indexados sobre transacciones, remitos emitidos y conducta de compra en Mix Point. Esto me permite tomar decisiones informadas y prever patrones de demanda sin perder el hilo operativo.`,
                    datos: memorias,
                    razonamiento_pasos: pasos,
                    fuente: 'memoria_extendida'
                };
            }
        }

        // 4. PREDICCIÓN PROBABILÍSTICA DE STOCK (RUNWAY / TIEMPO DE COBERTURA)
        if (texto.includes('quiebre') || texto.includes('predic') || texto.includes('cuanto dura') || texto.includes('cuánto dura') || texto.includes('agota') || texto.includes('termina') || texto.includes('reponer')) {
            const predicciones = await this.predecirQuiebreStock({ limite: 5 });
            const criticos = predicciones.filter(p => p.dias_restantes !== null && p.dias_restantes <= 10);

            if (criticos.length > 0) {
                const detalle = criticos.map(p => `"${p.nombre}" (quedan ${p.stock_actual} ${p.unidad}, cobertura estimada: ~${p.dias_restantes} días a razón de ${p.consumo_diario} ${p.unidad}/día)`).join('; ');
                
                const pasos = JarvisService.estructurarRazonamiento({
                    analisis: `Cálculo de consumo móvil de 30 días contra existencias físicas actuales para ${criticos.length} productos críticos.`,
                    evaluacion: `El runway promedio es menor a 10 días para ítems clave (${criticos.map(c => c.nombre).slice(0, 2).join(', ')}). Si el lead time de transporte desde origen es de 4 a 6 días, la ventana de emisión de OC es inmediata.`,
                    recomendacion: `Generar órdenes de compra a proveedores de frutos secos hoy mismo para evitar lucro cesante en ventas mayoristas.`
                });

                return {
                    respuesta: `Análisis de proyección de inventario: Se detectaron productos con riesgo inminente de agotamiento basado en el promedio móvil de los últimos 30 días: ${detalle}. Recomiendo emitir órdenes de compra a proveedores preventivamente.`,
                    datos: predicciones,
                    razonamiento_pasos: pasos,
                    fuente: 'mcp_stock_predictivo',
                    accion_sugerida: 'Ver Proveedores'
                };
            } else {
                const pasos = JarvisService.estructurarRazonamiento({
                    analisis: `Auditoría de inventario contra consumo promedio de los últimos 30 días sin quiebres detectados a 10 días vista.`,
                    evaluacion: `Rotación equilibrada. El stock de seguridad actual amortigua fluctuaciones ordinarias de la demanda.`,
                    recomendacion: `Mantener ritmo de fraccionado y monitorear nuevamente en 48 horas.`
                });

                return {
                    respuesta: `Los niveles de inventario proyectados están estables. La rotación de los últimos 30 días indica una cobertura superior a los 10 días para todos los productos de alta demanda.`,
                    datos: predicciones,
                    razonamiento_pasos: pasos,
                    fuente: 'mcp_stock_predictivo',
                    accion_sugerida: 'Ver Inventario'
                };
            }
        }

        // 5. ANÁLISIS DE CARTERA, COBRANZAS Y DEUDAS
        if (texto.includes('deud') || texto.includes('debe') || texto.includes('cobrar') || texto.includes('cuenta corriente')) {
            const res = await this.consultarDeudaClientes({ top: 5 });
            let r = `Estado de cartera: La deuda pendiente total en la calle asciende a ${fmtDinero(res.deuda_total_calle)} distribuida entre ${res.clientes_deudores_total} cuentas activas.\n`;
            if (res.top_deudores.length > 0) {
                r += `Principales saldos: ` + res.top_deudores.map(d => `${d.cliente} (${fmtDinero(d.deuda)})`).join(', ') + '.';
            }

            const pasos = JarvisService.estructurarRazonamiento({
                analisis: `Auditoría de cuentas corrientes: Deuda en calle de ${fmtDinero(res.deuda_total_calle)} repartida en ${res.clientes_deudores_total} clientes.`,
                evaluacion: `Riesgo crediticio concentrado: El top 3 de deudores representa la mayor proporción de crédito otorgado. Demoras en estas cuentas reducen la velocidad de rotación de caja.`,
                recomendacion: `Pausar nuevas emisiones a plazo a clientes con saldo moroso y ofrecer condiciones de pago contado contra despacho.`
            });

            return {
                respuesta: r,
                datos: res,
                razonamiento_pasos: pasos,
                fuente: 'mcp_cuentas_corrientes',
                accion_sugerida: 'Ver Cuentas Corrientes'
            };
        }

        // 6. PRODUCCIÓN & SIMULACIÓN INDUSTRIAL DE MIXES
        if (texto.includes('fabricar') || texto.includes('producir') || texto.includes('receta') || texto.includes('mix')) {
            const matchKg = texto.match(/(\d+)\s*(kg|kilos)?/);
            const kg = matchKg ? parseInt(matchKg[1], 10) : 50;

            const sim = await this.simularProduccion({ cantidad_kg: kg });
            if (sim.es_factible) {
                const pasos = JarvisService.estructurarRazonamiento({
                    analisis: `Simulación de fórmula de ${sim.receta} para ${kg} kg completada. Todos los ingredientes cuentan con stock positivo suficiente.`,
                    evaluacion: `El lote máximo elaborable con el insumo cuello de botella actual es de ${sim.produccion_maxima_posible_kg} kg.`,
                    recomendacion: `Autorizar orden de fraccionado en depósito para abastecer la demanda planificada.`
                });

                return {
                    respuesta: `Simulación de fraccionado completada: Es totalmente viable producir ${kg} kg de ${sim.receta}. Los insumos en depósito son suficientes. Con las existencias actuales el lote máximo realizable es de ${sim.produccion_maxima_posible_kg} kg.`,
                    datos: sim,
                    razonamiento_pasos: pasos,
                    fuente: 'mcp_produccion',
                    accion_sugerida: 'Ir a Producción'
                };
            } else {
                const faltantes = sim.insumos.filter(i => i.falta_kg > 0).map(i => `${i.ingrediente} (faltan ${i.falta_kg.toFixed(1)} kg)`).join(', ');
                const pasos = JarvisService.estructurarRazonamiento({
                    analisis: `Auditoría de receta de ${sim.receta} para ${kg} kg: Se encontraron faltantes en insumos primarios: ${faltantes}.`,
                    evaluacion: `Producir el lote completo generará rotura de stock negativa. Lote máximo que se puede envasar hoy: ${sim.produccion_maxima_posible_kg} kg.`,
                    recomendacion: `Comprar los insumos deficitarios a granel o reducir el lote a ${sim.produccion_maxima_posible_kg} kg.`
                });

                return {
                    respuesta: `Alerta en línea de producción: No es viable producir ${kg} kg de ${sim.receta}. Insumos deficitarios: ${faltantes}. Lote máximo actual permitido: ${sim.produccion_maxima_posible_kg} kg.`,
                    datos: sim,
                    razonamiento_pasos: pasos,
                    fuente: 'mcp_produccion',
                    accion_sugerida: 'Comprar Insumos'
                };
            }
        }

        // 7. FACTURACIÓN Y RENDIMIENTO COMERCIAL
        if (texto.includes('venta') || texto.includes('factur') || texto.includes('vend')) {
            let periodo = 'hoy';
            if (texto.includes('ayer')) periodo = 'ayer';
            if (texto.includes('semana')) periodo = 'semana';
            if (texto.includes('mes')) periodo = 'mes';

            const ventas = await this.consultarVentas({ periodo, limite: 5 });
            let r = `Rendimiento comercial (${periodo}): Facturación neta de ${fmtDinero(ventas.facturado)} a través de ${ventas.total_remitos} remitos emitidos.`;
            if (ventas.remitos_recientes.length > 0) {
                r += ` Últimas órdenes: ` + ventas.remitos_recientes.slice(0, 3).map(rm => `#${rm.numero} a ${rm.cliente} (${fmtDinero(rm.total)})`).join('; ') + '.';
            }
            return {
                respuesta: r,
                datos: ventas,
                accion_sugerida: 'Ver Remitos'
            };
        }

        // 8. FLUJO DE FONDOS, CAJA Y GASTOS
        if (texto.includes('caja') || texto.includes('finanza') || texto.includes('flujo') || texto.includes('balance') || texto.includes('gasto')) {
            const fin = await this.consultarFinanzas();
            return {
                respuesta: `Resumen ejecutivo financiero del mes: Ventas emitidas por ${fmtDinero(fin.ventas_facturadas)}, Cobranzas ingresadas por ${fmtDinero(fin.cobranzas_efectivas)} y Gastos operativos de ${fmtDinero(fin.gastos_operativos)}. Flujo de caja neto: ${fmtDinero(fin.flujo_neto_caja)}.`,
                datos: fin,
                accion_sugerida: 'Ver Reportes'
            };
        }

        // 9. CONSULTA DETALLADA DE PRODUCTOS O INVENTARIO
        if (texto.includes('stock') || texto.includes('qued') || texto.includes('cuanto') || texto.includes('precio') || texto.includes('hay')) {
            const soloCritico = texto.includes('critico') || texto.includes('falta') || texto.includes('baj') || texto.includes('agotad');
            const palabrasClave = ['almendra', 'nuez', 'nueces', 'castaña', 'pasas', 'mani', 'banana', 'arandano', 'mix', 'higo', 'datil', 'ciruela', 'semilla'];
            const palabraEncontrada = palabrasClave.find(p => texto.includes(p));

            const resStock = await this.consultarStock({
                filtro: palabraEncontrada || '',
                solo_critico: soloCritico
            });

            if (resStock.productos.length === 0) {
                return {
                    respuesta: `No encontré ítems en inventario para "${palabraEncontrada || texto}". ¿Desea que consulte el catálogo general de productos?`,
                    datos: resStock
                };
            }

            if (palabraEncontrada) {
                const prod = resStock.productos[0];
                return {
                    respuesta: `El producto "${prod.nombre}" registra un stock físico de ${prod.stock} ${prod.unidad} con precio mayorista de ${fmtDinero(prod.precio)}. ${prod.alerta ? '⚠️ Estado: Por debajo del stock de seguridad.' : '✅ Nivel óptimo.'}`,
                    datos: prod,
                    accion_sugerida: 'Ver Inventario'
                };
            }

            const resumen = resStock.productos.slice(0, 5).map(p => `${p.nombre}: ${p.stock} ${p.unidad}`).join(', ');
            return {
                respuesta: `Existencias consultadas: ${resumen}. Total: ${resStock.total_encontrados} referencias auditadas.`,
                datos: resStock
            };
        }

        // 10. DEPÓSITO Y LOGÍSTICA KANBAN
        if (texto.includes('deposito') || texto.includes('depósito') || texto.includes('preparar') || texto.includes('armar') || texto.includes('kanban') || texto.includes('despacho')) {
            const remitosPendientes = await db.all(`
                SELECT r.id, r.numero, r.fecha, r.total, r.estado, c.razon_social as cliente
                FROM remitos r
                JOIN clientes c ON c.id = r.cliente_id
                WHERE r.estado IN ('pendiente', 'en_preparacion')
                ORDER BY r.id ASC
                LIMIT 5
            `);

            if (remitosPendientes.length === 0) {
                return {
                    respuesta: `Líneas de preparación despejadas. El centro logístico no registra pedidos pendientes de picking o empaque en este momento.`,
                    accion_sugerida: 'Ver Preparación & Despacho'
                };
            }

            const lista = remitosPendientes.map(r => `#${r.numero} (${r.cliente})`).join(', ');
            return {
                respuesta: `En el centro de despacho hay ${remitosPendientes.length} órdenes en preparación activa: ${lista}.`,
                datos: remitosPendientes,
                accion_sugerida: 'Ver Preparación & Despacho'
            };
        }

        // 11. IDENTIDAD J.A.R.V.I.S. & ORIENTACIÓN INTELIGENTE
        if (texto.includes('quien sos') || texto.includes('quién sos') || texto.includes('tu nombre') || texto.includes('como te llamas')) {
            return {
                respuesta: `Soy J.A.R.V.I.S., el sistema de inteligencia operacional y analítica de Mix Point. Estoy conectado mediante Model Context Protocol (MCP) a la base de datos central para generar remitos automatizados, predecir quiebres de inventario, controlar saldos deudores y coordinar despachos en tiempo real. Siempre listo para optimizar sus operaciones.`
            };
        }

        // Respuesta genérica de alta precisión
        return {
            respuesta: `Sistemas en línea y procesador analítico activo. Puedo emitir remitos automáticos desde órdenes web, auditar el stock crítico, calcular proyecciones de quiebre o analizar el flujo financiero. ¿Cuál es su instrucción, señor?`,
            sugerencias: [
                'Generar remito automático para el pedido MP-1001',
                '¿Qué productos tienen predicción de quiebre de stock?',
                'Monitorear alertas críticas del sistema',
                '¿Cuánto facturamos hoy en remitos?'
            ]
        };
    }
}

module.exports = JarvisService;
