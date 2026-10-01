const db = require('../db/pool');

/**
 * Motor de Inteligencia de Negocios y Asistente "Jarvis" para Mix Point
 */
class JarvisService {
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
                SELECT rd.producto_id,
                       COALESCE(SUM(rd.cantidad), 0) as total_vendido_30d,
                       ROUND(COALESCE(SUM(rd.cantidad), 0) / 30.0, 2) as consumo_diario_promedio
                FROM remitos_detalle rd
                JOIN remitos r ON r.id = rd.remito_id
                WHERE r.fecha >= CURRENT_DATE - INTERVAL '30 days'
                  AND r.estado NOT IN ('cancelado', 'anulado')
                GROUP BY rd.producto_id
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
    static async consultarVentas({ periodo = 'hoy', limite = 10 } = {}) {
        let filtroFecha = "fecha = CURRENT_DATE";
        if (periodo === 'ayer') filtroFecha = "fecha = CURRENT_DATE - INTERVAL '1 day'";
        if (periodo === 'semana') filtroFecha = "fecha >= CURRENT_DATE - INTERVAL '7 days'";
        if (periodo === 'mes') filtroFecha = "fecha >= DATE_TRUNC('month', CURRENT_DATE)";

        const resumen = await db.one(`
            SELECT COUNT(*)::int as total_remitos, COALESCE(SUM(total), 0) as facturado
            FROM remitos
            WHERE ${filtroFecha}
        `);

        const detalles = await db.all(`
            SELECT r.id, r.numero, r.fecha, r.total, c.razon_social as cliente
            FROM remitos r
            JOIN clientes c ON c.id = r.cliente_id
            WHERE ${filtroFecha}
            ORDER BY r.fecha DESC, r.id DESC
            LIMIT $1
        `, [Math.min(parseInt(limite) || 10, 30)]);

        return {
            periodo,
            total_remitos: resumen.total_remitos,
            facturado: Number(resumen.facturado),
            remitos_recientes: detalles.map(d => ({
                numero: d.numero,
                cliente: d.cliente,
                fecha: String(d.fecha).slice(0, 10),
                total: Number(d.total)
            }))
        };
    }

    /**
     * Consulta de cuentas corrientes y deudores principales
     */
    static async consultarDeudaClientes({ top = 5 } = {}) {
        const totalDeuda = await db.one(`
            SELECT COALESCE(SUM(saldo_cuenta), 0) as total, COUNT(*)::int as clientes_con_deuda
            FROM clientes WHERE saldo_cuenta > 0
        `);

        const deudores = await db.all(`
            SELECT id, razon_social, telefono, saldo_cuenta, limite_credito, plazo_dias
            FROM clientes
            WHERE saldo_cuenta > 0
            ORDER BY saldo_cuenta DESC
            LIMIT $1
        `, [top]);

        return {
            deuda_total_calle: Number(totalDeuda.total),
            clientes_deudores_total: totalDeuda.clientes_con_deuda,
            top_deudores: deudores.map(d => ({
                id: d.id,
                cliente: d.razon_social,
                deuda: Number(d.saldo_cuenta),
                limite: Number(d.limite_credito || 0),
                plazo_dias: d.plazo_dias,
                telefono: d.telefono || 'Sin teléfono'
            }))
        };
    }

    /**
     * Consulta financiera global del mes
     */
    static async consultarFinanzas() {
        const ventasMes = await db.one(`
            SELECT COALESCE(SUM(total), 0) as total_ventas
            FROM remitos
            WHERE fecha >= DATE_TRUNC('month', CURRENT_DATE)
        `);

        const cobranzasMes = await db.one(`
            SELECT COALESCE(SUM(monto), 0) as total_cobranzas
            FROM movimientos_cuenta
            WHERE entidad_tipo = 'cliente' AND tipo IN ('cobro', 'pago')
              AND fecha >= DATE_TRUNC('month', CURRENT_DATE)
        `);

        const gastosMes = await db.one(`
            SELECT COALESCE(SUM(monto), 0) as total_gastos
            FROM gastos
            WHERE fecha >= DATE_TRUNC('month', CURRENT_DATE)
        `);

        const v = Number(ventasMes.total_ventas);
        const c = Number(cobranzasMes.total_cobranzas);
        const g = Number(gastosMes.total_gastos);

        return {
            mes_actual: new Date().toISOString().slice(0, 7),
            ventas_facturadas: v,
            cobranzas_efectivas: c,
            gastos_operativos: g,
            flujo_neto_caja: c - g
        };
    }

    /**
     * Simulación de producción de mixes: comprueba factibilidad de insumos
     */
    static async simularProduccion({ receta_nombre = '', cantidad_kg = 50 } = {}) {
        let receta = null;
        if (receta_nombre) {
            receta = await db.one(`
                SELECT r.*, p.nombre as producto_nombre
                FROM recetas r
                JOIN productos p ON p.id = r.producto_id
                WHERE r.activo = true AND (r.nombre ILIKE $1 OR p.nombre ILIKE $1)
                LIMIT 1
            `, [`%${receta_nombre.trim()}%`]);
        }

        if (!receta) {
            receta = await db.one(`
                SELECT r.*, p.nombre as producto_nombre
                FROM recetas r
                JOIN productos p ON p.id = r.producto_id
                WHERE r.activo = true LIMIT 1
            `);
        }

        if (!receta) return { factible: false, error: 'No hay recetas de producción configuradas.' };

        const ingredientes = await db.all(`
            SELECT ri.*, p.nombre as ingrediente_nombre, p.stock_actual as stock_disponible, p.unidad_medida
            FROM receta_ingredientes ri
            JOIN productos p ON p.id = ri.producto_ingrediente_id
            WHERE ri.receta_id = $1
        `, [receta.id]);

        let esFactible = true;
        let cantMaxPosible = Infinity;
        const insumosDetalle = [];

        for (const ing of ingredientes) {
            const kgRequeridos = (cantidad_kg * (Number(ing.porcentaje) / 100));
            const disp = Number(ing.stock_disponible);
            const falta = Math.max(0, kgRequeridos - disp);

            if (disp < kgRequeridos) esFactible = false;

            const maxConEste = ing.porcentaje > 0 ? (disp / (Number(ing.porcentaje) / 100)) : Infinity;
            if (maxConEste < cantMaxPosible) cantMaxPosible = maxConEste;

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
     * Responde una pregunta en lenguaje natural usando motor analítico o Gemini
     */
    static async responderConsulta(pregunta) {
        const texto = (pregunta || '').toLowerCase().trim();
        const geminiKey = process.env.GEMINI_API_KEY;

        // Si tenemos API Key de Gemini, podemos enriquecer la interacción con el modelo
        if (geminiKey) {
            try {
                return await this.responderConGemini(pregunta, geminiKey);
            } catch (err) {
                console.warn('Fallo llamada a Gemini API, usando motor analítico local:', err.message);
            }
        }

        // Motor Analítico Local de Alta Precisión (Fallback robusto y siempre disponible)
        return await this.responderMotorLocal(texto);
    }

    /**
     * Motor analítico semántico local
     */
    static async responderMotorLocal(texto) {
        const fmtDinero = n => `$ ${Number(n).toLocaleString('es-AR')}`;

        // 1. Preguntas sobre Deuda / Cuentas Corrientes
        if (texto.includes('deud') || texto.includes('debe') || texto.includes('cobrar') || texto.includes('cuenta corriente')) {
            const res = await this.consultarDeudaClientes({ top: 5 });
            let r = `Actualmente la deuda total en la calle es de ${fmtDinero(res.deuda_total_calle)} distribuida en ${res.clientes_deudores_total} clientes. `;
            if (res.top_deudores.length > 0) {
                r += `Los principales deudores son: ` + res.top_deudores.map(d => `${d.cliente} (${fmtDinero(d.deuda)})`).join(', ') + '.';
            }
            return {
                respuesta: r,
                datos: res,
                accion_sugerida: 'Ver Cuentas Corrientes'
            };
        }

        // 2. Preguntas sobre Producción / Simulación de Mix
        if (texto.includes('fabricar') || texto.includes('producir') || texto.includes('receta') || texto.includes('mix')) {
            // Extraer cantidad si existe número
            const matchKg = texto.match(/(\d+)\s*(kg|kilos)?/);
            const kg = matchKg ? parseInt(matchKg[1], 10) : 50;

            const sim = await this.simularProduccion({ cantidad_kg: kg });
            if (sim.es_factible) {
                return {
                    respuesta: `¡Sí, es factible elaborar ${kg} kg de ${sim.receta}! Contamos con stock de todos los ingredientes necesarios. De hecho, con los insumos actuales podés producir hasta ${sim.produccion_maxima_posible_kg} kg.`,
                    datos: sim,
                    accion_sugerida: 'Ir a Producción'
                };
            } else {
                const faltantes = sim.insumos.filter(i => i.falta_kg > 0).map(i => `${i.ingrediente} (faltan ${i.falta_kg.toFixed(1)} kg)`).join(', ');
                return {
                    respuesta: `No es factible elaborar ${kg} kg de ${sim.receta} en este momento. Insumos insuficientes: ${faltantes}. La cantidad máxima que se puede elaborar hoy es de ${sim.produccion_maxima_posible_kg} kg.`,
                    datos: sim,
                    accion_sugerida: 'Comprar Insumos'
                };
            }
        }

        // 3. Preguntas sobre Ventas / Facturación
        if (texto.includes('venta') || texto.includes('factur') || texto.includes('vend')) {
            let periodo = 'hoy';
            if (texto.includes('ayer')) periodo = 'ayer';
            if (texto.includes('semana')) periodo = 'semana';
            if (texto.includes('mes')) periodo = 'mes';

            const ventas = await this.consultarVentas({ periodo, limite: 5 });
            let r = `En el período (${periodo}) se registraron ${ventas.total_remitos} ventas por un total de ${fmtDinero(ventas.facturado)}.`;
            if (ventas.remitos_recientes.length > 0) {
                r += ` Últimos remitos: ` + ventas.remitos_recientes.slice(0, 3).map(rm => `${rm.numero} a ${rm.cliente} (${fmtDinero(rm.total)})`).join('; ') + '.';
            }
            return {
                respuesta: r,
                datos: ventas,
                accion_sugerida: 'Ver Remitos'
            };
        }

        // 4. Preguntas sobre Finanzas / Caja / Flujo
        if (texto.includes('caja') || texto.includes('finanza') || texto.includes('flujo') || texto.includes('balance') || texto.includes('gasto')) {
            const fin = await this.consultarFinanzas();
            return {
                respuesta: `Resumen financiero del mes: Ventas facturadas por ${fmtDinero(fin.ventas_facturadas)}, Cobranzas ingresadas por ${fmtDinero(fin.cobranzas_efectivas)} y Gastos operativos por ${fmtDinero(fin.gastos_operativos)}. El flujo neto de caja actual es de ${fmtDinero(fin.flujo_neto_caja)}.`,
                datos: fin,
                accion_sugerida: 'Ver Reportes'
            };
        }

        // 5. Predicción inteligente de quiebre de stock
        if (texto.includes('quiebre') || texto.includes('predic') || texto.includes('cuanto dura') || texto.includes('cuánto dura') || texto.includes('agota') || texto.includes('termina') || texto.includes('reponer')) {
            const predicciones = await this.predecirQuiebreStock({ limite: 5 });
            const criticos = predicciones.filter(p => p.dias_restantes !== null && p.dias_restantes <= 10);
            
            if (criticos.length > 0) {
                const detalle = criticos.map(p => `${p.nombre} (quedan ${p.stock_actual} ${p.unidad}, dura ~${p.dias_restantes} días con venta de ${p.consumo_diario} ${p.unidad}/día)`).join('; ');
                return {
                    respuesta: `⚠️ Predicción de quiebre de stock: Hay productos en riesgo inminente según el ritmo de venta de los últimos 30 días: ${detalle}. Se sugiere reponer mercadería.`,
                    datos: predicciones,
                    accion_sugerida: 'Ver Compras a Proveedores'
                };
            } else {
                return {
                    respuesta: `✅ Según el análisis de rotación de los últimos 30 días, el inventario principal cuenta con cobertura para más de 10 días de venta normal.`,
                    datos: predicciones,
                    accion_sugerida: 'Ver Inventario'
                };
            }
        }

        // 6. Preguntas sobre Stock o Productos
        if (texto.includes('stock') || texto.includes('qued') || texto.includes('alerta') || texto.includes('cuanto') || texto.includes('precio') || texto.includes('hay')) {
            const soloCritico = texto.includes('critico') || texto.includes('falta') || texto.includes('baj') || texto.includes('agotad');
            
            // Extraer posible nombre de producto (nueces, almendras, castañas, etc.)
            const palabrasClave = ['almendra', 'nuez', 'nueces', 'castaña', 'pasas', 'mani', 'banana', 'arandano', 'mix', 'higo', 'datil', 'ciruela', 'semilla'];
            const palabraEncontrada = palabrasClave.find(p => texto.includes(p));

            const resStock = await this.consultarStock({
                filtro: palabraEncontrada || '',
                solo_critico: soloCritico
            });

            if (resStock.productos.length === 0) {
                return {
                    respuesta: `No encontré productos que coincidan con "${palabraEncontrada || texto}". ¿Querés consultar el catálogo completo?`,
                    datos: resStock
                };
            }

            if (palabraEncontrada) {
                const prod = resStock.productos[0];
                return {
                    respuesta: `El producto "${prod.nombre}" tiene un stock actual de ${prod.stock} ${prod.unidad} a un precio de venta de ${fmtDinero(prod.precio)}. ${prod.alerta ? '⚠️ ¡Atención: está cerca del umbral mínimo!' : '✅ Nivel de stock adecuado.'}`,
                    datos: prod,
                    accion_sugerida: 'Ver Inventario'
                };
            }

            if (soloCritico) {
                const nombres = resStock.productos.slice(0, 5).map(p => `${p.nombre} (${p.stock} ${p.unidad})`).join(', ');
                return {
                    respuesta: `Hay ${resStock.total_encontrados} productos con stock crítico o agotado: ${nombres}.`,
                    datos: resStock,
                    accion_sugerida: 'Ajustar Stock'
                };
            }

            const resumen = resStock.productos.slice(0, 5).map(p => `${p.nombre}: ${p.stock} ${p.unidad}`).join(', ');
            return {
                respuesta: `Inventario disponible: ${resumen}. Total consultado: ${resStock.total_encontrados} ítems.`,
                datos: resStock
            };
        }

        // Respuesta genérica de bienvenida y guía de voz
        return {
            respuesta: `Hola, soy Jarvis, el asistente de Mix Point. Puedo informarte sobre stock disponible, alertarte de productos críticos, consultar ventas de hoy, ver quién nos debe dinero o simular si alcanza la materia prima para elaborar mixes. ¿Qué te gustaría consultar?`,
            sugerencias: [
                '¿Cuánto stock tenemos de almendras?',
                '¿Quién nos debe más dinero?',
                '¿Podemos elaborar 50 kg de mix?',
                'Resumen de ventas de hoy',
                '¿Cómo está el flujo de caja del mes?'
            ]
        };
    }

    /**
     * Integración con Gemini REST con Function Calling
     */
    static async responderConGemini(pregunta, apiKey) {
        // Enriquecer el contexto del prompt con datos operacionales frescos
        const [stockCritico, ventasHoy, deuda] = await Promise.all([
            this.consultarStock({ solo_critico: true }),
            this.consultarVentas({ periodo: 'hoy' }),
            this.consultarDeudaClientes({ top: 3 })
        ]);

        const systemPrompt = `Sos Jarvis, el asistente de inteligencia operativa de "Mix Point", una empresa mayorista de frutos secos de Argentina.
Tu tono es profesional, conciso, ejecutivo y cordial.
Hablas en español rioplatense neutro claro apto para ser leído por voz (Text-to-Speech).
Datos en vivo de Mix Point:
- Ventas de hoy: $${ventasHoy.facturado} (${ventasHoy.total_remitos} remitos).
- Deuda total en la calle: $${deuda.deuda_total_calle}.
- Productos en alerta de stock: ${stockCritico.total_encontrados} productos.
Respondé de forma directa, útil y breve para que el usuario pueda escucharlo con comodidad por voz.`;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
        const body = {
            contents: [
                { role: 'user', parts: [{ text: `${systemPrompt}\n\nPregunta del usuario: "${pregunta}"` }] }
            ]
        };

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            throw new Error(`Gemini API error: ${res.statusText}`);
        }

        const data = await res.json();
        const textoRespuesta = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!textoRespuesta) throw new Error('Respuesta vacía de Gemini');

        return {
            respuesta: textoRespuesta,
            motor: 'gemini'
        };
    }
}

module.exports = JarvisService;
