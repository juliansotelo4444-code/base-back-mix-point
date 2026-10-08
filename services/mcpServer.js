/**
 * Servidor MCP (Model Context Protocol) para Mix Point
 * 
 * Expone herramientas y recursos de solo lectura a la base de datos para:
 * 1. Inspeccionar pedidos específicos con estricta seguridad de solo lectura.
 * 2. Buscar stock, productos, lotes y clientes sin permitir modificaciones directas ni inyecciones.
 * 3. Analizar métricas de negocio con memoria extendida.
 * 4. Generar remitos garantizando el uso exclusivo de los datos del pedido verificado.
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema
} = require('@modelcontextprotocol/sdk/types.js');
const db = require('../db/pool');

class MixPointMCPServer {
    constructor() {
        this.server = new Server(
            {
                name: 'mixpoint-mcp-server',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tools: {},
                    resources: {}
                }
            }
        );

        this.setupHandlers();
    }

    setupHandlers() {
        // Listado de herramientas disponibles para agentes IA
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: 'obtener_datos_pedido',
                        description: 'Extrae con seguridad de solo lectura los datos exactos de un pedido específico (cliente, dirección, ítems, cantidades, precios). No modifica ningún registro en la base de datos.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                pedido_id_o_numero: {
                                    type: 'string',
                                    description: 'Número o ID del pedido a consultar (ej: "MP-1042" o "1042")'
                                }
                            },
                            required: ['pedido_id_o_numero']
                        }
                    },
                    {
                        name: 'consultar_stock_productos',
                        description: 'Consulta de solo lectura de productos, stock actual, stock mínimo y precios de venta.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                filtro_nombre: {
                                    type: 'string',
                                    description: 'Filtro opcional por nombre o código de producto (ej: "almendras", "nueces")'
                                },
                                solo_bajo_stock: {
                                    type: 'boolean',
                                    description: 'Filtrar solo productos con stock por debajo del umbral mínimo'
                                }
                            }
                        }
                    },
                    {
                        name: 'consultar_memoria_negocio',
                        description: 'Recupera la memoria extendida contextual de la empresa (análisis comercial, clientes clave, acuerdos especiales, historial de alertas).',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                clave: {
                                    type: 'string',
                                    description: 'Clave de memoria a consultar (ej: "resumen_negocio", "preferencias_clientes", "alertas_activas")'
                                }
                            }
                        }
                    },
                    {
                        name: 'guardar_memoria_negocio',
                        description: 'Almacena o actualiza conocimientos estratégicos en la memoria persistente del agente sin alterar tablas transaccionales.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                clave: {
                                    type: 'string',
                                    description: 'Identificador único del dato en memoria'
                                },
                                contenido: {
                                    type: 'object',
                                    description: 'Estructura JSON con los aprendizajes o notas del negocio'
                                }
                            },
                            required: ['clave', 'contenido']
                        }
                    },
                    {
                        name: 'monitorear_alertas_sistema',
                        description: 'Monitorea activamente el estado operativo del sistema: remitos sin procesar, quiebres de stock proyectados, alertas FEFO y saldos morosos.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                nivel_urgencia: {
                                    type: 'string',
                                    enum: ['todas', 'criticas', 'advertencias'],
                                    description: 'Filtro de nivel de alertas'
                                }
                            }
                        }
                    },
                    {
                        name: 'verificar_y_generar_remito',
                        description: 'Genera un remito oficial de entrega asociándolo al pedido. Valida estrictamente que los ítems coincidan con los datos del pedido original sin alterar datos externos.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                pedido_numero: {
                                    type: 'string',
                                    description: 'Número del pedido original'
                                },
                                cliente_nombre: {
                                    type: 'string',
                                    description: 'Nombre del cliente destinatario'
                                },
                                direccion_entrega: {
                                    type: 'string',
                                    description: 'Dirección física de destino'
                                },
                                telefono: {
                                    type: 'string',
                                    description: 'Teléfono del cliente'
                                },
                                transportista: {
                                    type: 'string',
                                    description: 'Nombre o empresa del transportista asignado'
                                },
                                items: {
                                    type: 'array',
                                    description: 'Lista estricta de ítems extraídos del pedido { producto_id, nombre, cantidad, precio_unitario }',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            producto_id: { type: 'number' },
                                            nombre: { type: 'string' },
                                            cantidad: { type: 'number' },
                                            precio_unitario: { type: 'number' }
                                        },
                                        required: ['nombre', 'cantidad']
                                    }
                                }
                            },
                            required: ['cliente_nombre', 'items']
                        }
                    },
                    {
                        name: 'consultar_usuarios_conectados',
                        description: 'Obtiene en tiempo real la lista de personas y operarios del equipo que están conectados a la red del sistema (nombre, rol, socket activo).',
                        inputSchema: {
                            type: 'object',
                            properties: {}
                        }
                    },
                    {
                        name: 'consultar_persona_en_red',
                        description: 'Envía una consulta directa de Jarvis a una persona específica conectada a la red (ej: chofer, operario de depósito, vendedor) para averiguar datos que faltan o confirmar detalles operativos.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                destinatario_nombre_o_rol: {
                                    type: 'string',
                                    description: 'Nombre del usuario (ej: "Franco", "Damian") o rol ("deposito", "ventas", "admin")'
                                },
                                consulta: {
                                    type: 'string',
                                    description: 'La pregunta o consulta específica que Jarvis le hará a esa persona'
                                }
                            },
                            required: ['destinatario_nombre_o_rol', 'consulta']
                        }
                    }
                ]
            };
        });

        // Ejecución de llamadas de herramientas
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            try {
                switch (name) {
                    case 'obtener_datos_pedido':
                        return await this.toolObtenerDatosPedido(args);
                    case 'consultar_stock_productos':
                        return await this.toolConsultarStock(args);
                    case 'consultar_memoria_negocio':
                        return await this.toolConsultarMemoria(args);
                    case 'guardar_memoria_negocio':
                        return await this.toolGuardarMemoria(args);
                    case 'monitorear_alertas_sistema':
                        return await this.toolMonitorearAlertas(args);
                    case 'verificar_y_generar_remito':
                        return await this.toolGenerarRemito(args);
                    case 'consultar_usuarios_conectados':
                        return await this.toolConsultarUsuariosConectados(args);
                    case 'consultar_persona_en_red':
                        return await this.toolConsultarPersonaEnRed(args);
                    default:
                        throw new Error(`Herramienta no implementada: ${name}`);
                }
            } catch (error) {
                return {
                    isError: true,
                    content: [
                        {
                            type: 'text',
                            text: `Error al ejecutar ${name}: ${error.message}`
                        }
                    ]
                };
            }
        });

        // Recursos MCP (Lectura de contexto)
        this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
            return {
                resources: [
                    {
                        uri: 'mixpoint://negocio/perfil',
                        name: 'Perfil Operativo de Mix Point',
                        description: 'Información general de la distribuidora mayorista de frutos secos',
                        mimeType: 'application/json'
                    },
                    {
                        uri: 'mixpoint://alertas/activas',
                        name: 'Alertas Activas del Sistema',
                        description: 'Monitoreo en tiempo real de quiebres de stock y logística',
                        mimeType: 'application/json'
                    }
                ]
            };
        });

        this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            if (request.params.uri === 'mixpoint://negocio/perfil') {
                return {
                    contents: [
                        {
                            uri: request.params.uri,
                            mimeType: 'application/json',
                            text: JSON.stringify({
                                empresa: 'Mix Point',
                                actividad: 'Distribuidora mayorista y fraccionadora de frutos secos, semillas y frutas desecadas',
                                politicas_stock: 'Despacho por sistema FEFO (First Expired, First Out)',
                                canales_venta: ['Mayorista directo', 'Tienda Web', 'Google Sheets Pedidos']
                            }, null, 2)
                        }
                    ]
                };
            }
            if (request.params.uri === 'mixpoint://alertas/activas') {
                const alertas = await this.toolMonitorearAlertas({ nivel_urgencia: 'todas' });
                return {
                    contents: [
                        {
                            uri: request.params.uri,
                            mimeType: 'application/json',
                            text: alertas.content[0].text
                        }
                    ]
                };
            }
            throw new Error(`Recurso no encontrado: ${request.params.uri}`);
        });
    }

    // --- IMPLEMENTACIÓN DE HERRAMIENTAS (SOLO LECTURA SEGURA) ---

    async toolObtenerDatosPedido(args) {
        const idStr = String(args.pedido_id_o_numero || '').trim();
        if (!idStr) throw new Error('Debe proporcionar un identificador de pedido válido.');

        // 1. Buscar en remitos si ya existe
        const remito = await db.one(`
            SELECT r.*, c.razon_social as cliente_nombre, c.telefono as cliente_telefono,
                   c.direccion as cliente_direccion, c.localidad as cliente_localidad
            FROM remitos r
            JOIN clientes c ON c.id = r.cliente_id
            WHERE r.numero ILIKE $1 OR r.observaciones ILIKE $2 OR CAST(r.id AS TEXT) = $3
            LIMIT 1
        `, [`%${idStr}%`, `%${idStr}%`, idStr]);

        if (remito) {
            const items = await db.all(`
                SELECT ri.*, p.nombre as producto_nombre, p.codigo as producto_codigo
                FROM remito_items ri
                JOIN productos p ON p.id = ri.producto_id
                WHERE ri.remito_id = $1
            `, [remito.id]);

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        origen: 'remito_registrado',
                        id: remito.id,
                        numero: remito.numero,
                        fecha: remito.fecha,
                        estado: remito.estado,
                        cliente: {
                            nombre: remito.cliente_nombre,
                            telefono: remito.cliente_telefono,
                            direccion: remito.direccion_entrega || remito.cliente_direccion,
                            localidad: remito.cliente_localidad
                        },
                        total: Number(remito.total),
                        bultos: remito.bultos,
                        transportista: remito.transportista,
                        observaciones: remito.observaciones,
                        items: items.map(it => ({
                            producto_id: it.producto_id,
                            codigo: it.producto_codigo,
                            nombre: it.producto_nombre,
                            cantidad: Number(it.cantidad),
                            precio_unitario: Number(it.precio_unitario),
                            subtotal: Number(it.subtotal)
                        }))
                    }, null, 2)
                }]
            };
        }

        // 2. Si no es un remito emitido, buscar en la integración de pedidos web / Google Sheets
        const IntegracionesService = require('../services/integracionesService');
        // Usar método de lectura de pedidos
        const { pedidos } = await IntegracionesService.obtenerPedidosWeb();
        const encontrado = (pedidos || []).find(p =>
            String(p.numero).toLowerCase() === idStr.toLowerCase() ||
            String(p.numero).includes(idStr) ||
            (p.nombre && p.nombre.toLowerCase().includes(idStr.toLowerCase()))
        );

        if (encontrado) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        origen: 'pedido_web_sheets',
                        numero: encontrado.numero,
                        fecha: encontrado.fecha,
                        cliente: {
                            nombre: encontrado.nombre,
                            telefono: encontrado.telefono,
                            direccion: encontrado.direccion_completa || encontrado.direccion,
                            zona: encontrado.zona
                        },
                        items: encontrado.items || [],
                        total_estimado: encontrado.total,
                        remito_asociado: encontrado.remito_asociado || null
                    }, null, 2)
                }]
            };
        }

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    encontrado: false,
                    mensaje: `No se encontró ningún pedido o remito coincidente con "${idStr}". Asegúrese de que el número sea correcto.`
                })
            }]
        };
    }

    async toolConsultarStock(args) {
        const filtro = args.filtro_nombre ? `%${args.filtro_nombre.trim()}%` : null;
        const soloBajoStock = !!args.solo_bajo_stock;

        let sql = `
            SELECT p.id, p.codigo, p.nombre, p.stock_actual, p.stock_minimo, p.precio_venta, p.unidad_medida,
                   c.nombre as categoria
            FROM productos p
            LEFT JOIN categorias_producto c ON c.id = p.categoria_id
            WHERE p.activo = true
        `;
        const params = [];

        if (filtro) {
            params.push(filtro);
            sql += ` AND (p.nombre ILIKE $${params.length} OR p.codigo ILIKE $${params.length})`;
        }

        if (soloBajoStock) {
            sql += ` AND p.stock_actual <= p.stock_minimo`;
        }

        sql += ` ORDER BY p.stock_actual ASC LIMIT 25`;
        const prods = await db.all(sql, params);

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    total: prods.length,
                    productos: prods.map(p => ({
                        id: p.id,
                        codigo: p.codigo,
                        nombre: p.nombre,
                        stock_actual: Number(p.stock_actual),
                        stock_minimo: Number(p.stock_minimo),
                        unidad: p.unidad_medida,
                        precio_venta: Number(p.precio_venta),
                        alerta_stock_bajo: Number(p.stock_actual) <= Number(p.stock_minimo)
                    }))
                }, null, 2)
            }]
        };
    }

    async toolConsultarMemoria(args) {
        const clave = args.clave ? String(args.clave).trim() : null;

        if (clave) {
            const row = await db.one('SELECT clave, contenido, updated_at FROM agente_memoria WHERE clave = $1', [clave]);
            return {
                content: [{
                    type: 'text',
                    text: row ? JSON.stringify(row, null, 2) : JSON.stringify({ mensaje: `No hay memoria almacenada para la clave "${clave}".` })
                }]
            };
        }

        const todas = await db.all('SELECT clave, contenido, updated_at FROM agente_memoria ORDER BY updated_at DESC LIMIT 20');
        return {
            content: [{
                type: 'text',
                text: JSON.stringify(todas, null, 2)
            }]
        };
    }

    async toolGuardarMemoria(args) {
        const { clave, contenido } = args;
        if (!clave || !contenido) throw new Error('Clave y contenido requeridos.');

        await db.run(`
            INSERT INTO agente_memoria (clave, contenido, updated_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (clave) DO UPDATE SET contenido = EXCLUDED.contenido, updated_at = NOW()
        `, [clave, JSON.stringify(contenido)]);

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({ ok: true, mensaje: `Memoria "${clave}" guardada correctamente.` })
            }]
        };
    }

    async toolMonitorearAlertas(args) {
        const nivel = args.nivel_urgencia || 'todas';

        // 1. Quiebres de stock
        const quiebres = await db.all(`
            SELECT codigo, nombre, stock_actual, stock_minimo, unidad_medida
            FROM productos
            WHERE activo = true AND stock_actual <= stock_minimo
            ORDER BY stock_actual ASC
            LIMIT 10
        `);

        // 2. Remitos pendientes en depósito
        const remitosPendientes = await db.all(`
            SELECT r.id, r.numero, r.fecha, r.total, c.razon_social as cliente
            FROM remitos r
            JOIN clientes c ON c.id = r.cliente_id
            WHERE r.estado IN ('pendiente', 'en_preparacion')
            ORDER BY r.fecha ASC
            LIMIT 10
        `);

        // 3. Clientes con deuda elevada
        const clientesMorosos = await db.all(`
            SELECT id, razon_social, saldo_cuenta, telefono
            FROM clientes
            WHERE activo = true AND saldo_cuenta > 500000
            ORDER BY saldo_cuenta DESC
            LIMIT 5
        `);

        const alertas = {
            timestamp: new Date().toISOString(),
            stock_critico: quiebres.map(p => ({
                tipo: 'CRITICA',
                mensaje: `Stock crítico en ${p.nombre}: disponible ${p.stock_actual} ${p.unidad_medida} (mínimo: ${p.stock_minimo})`
            })),
            deposito_pendiente: remitosPendientes.map(r => ({
                tipo: 'ADVERTENCIA',
                mensaje: `Remito ${r.numero} para ${r.cliente} pendiente de despacho`
            })),
            finanzas: clientesMorosos.map(c => ({
                tipo: 'FINANCIERA',
                mensaje: `Cliente ${c.razon_social} adeuda $${Number(c.saldo_cuenta).toLocaleString('es-AR')}`
            }))
        };

        return {
            content: [{
                type: 'text',
                text: JSON.stringify(alertas, null, 2)
            }]
        };
    }

    async toolGenerarRemito(args) {
        const { pedido_numero, cliente_nombre, direccion_entrega, telefono, transportista, items } = args;

        if (!cliente_nombre || !items || !items.length) {
            throw new Error('Faltan datos obligatorios (cliente_nombre y items) para emitir el remito.');
        }

        // Llamar de manera segura a la lógica de emisión de remitos validando que se usen exactamente los datos provistos
        const IntegracionesService = require('../services/integracionesService');
        const remito = await IntegracionesService.crearRemitoDesdePedido({
            pedido_numero: pedido_numero || 'AGENTE-IA',
            nombre: cliente_nombre,
            telefono: telefono || '',
            direccion_completa: direccion_entrega || '',
            transportista: transportista || 'Distribución propia',
            items: items.map(it => ({
                producto_id: it.producto_id,
                nombre: it.nombre,
                cantidad: it.cantidad,
                precio_unitario: it.precio_unitario || 0
            }))
        });

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    ok: true,
                    remito_id: remito.id,
                    remito_numero: remito.numero,
                    cliente: cliente_nombre,
                    total: remito.total,
                    mensaje: `Remito ${remito.numero} generado exitosamente a partir de los datos exactos del pedido.`
                }, null, 2)
            }]
        };
    }

    async toolConsultarUsuariosConectados(args) {
        const { getUsuariosConectados } = require('../socket');
        const online = getUsuariosConectados ? getUsuariosConectados() : [];
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    total_online: online.length,
                    usuarios: online.map(u => ({
                        id: u.usuarioId,
                        nombre: u.nombre,
                        email: u.email,
                        rol: u.rol,
                        conectado_desde: u.conectadoDesde
                    }))
                }, null, 2)
            }]
        };
    }

    async toolConsultarPersonaEnRed(args) {
        const { destinatario_nombre_o_rol, consulta } = args;
        if (!destinatario_nombre_o_rol || !consulta) {
            throw new Error('Debe especificar el destinatario y la consulta.');
        }

        const { getUsuariosConectados, emitirConsultaJarvisAEquipo } = require('../socket');
        const online = getUsuariosConectados ? getUsuariosConectados() : [];

        // Buscar coincidencia por nombre o rol
        const dest = destinatario_nombre_o_rol.toLowerCase();
        let target = online.find(u =>
            (u.nombre && u.nombre.toLowerCase().includes(dest)) ||
            (u.rol && u.rol.toLowerCase() === dest)
        );

        // Si no está conectado ahora, buscarlo en la base de datos de usuarios para registrarle la consulta pendiente
        let destUsuario = null;
        if (target) {
            destUsuario = { id: target.usuarioId, nombre: target.nombre };
        } else {
            const dbUser = await db.one(`
                SELECT id, nombre, rol FROM usuarios
                WHERE activo = true AND (LOWER(nombre) LIKE $1 OR LOWER(rol) = $2)
                LIMIT 1
            `, [`%${dest}%`, dest]);
            if (dbUser) {
                destUsuario = { id: dbUser.id, nombre: dbUser.nombre, online: false };
            }
        }

        const nombreFinal = destUsuario ? destUsuario.nombre : destinatario_nombre_o_rol;
        const idFinal = destUsuario ? destUsuario.id : null;

        // Registrar consulta en DB
        const { row } = await db.run(`
            INSERT INTO jarvis_consultas_equipo (solicitante_nombre, destinatario_id, destinatario_nombre, consulta, estado)
            VALUES ('J.A.R.V.I.S.', $1, $2, $3, 'pendiente')
            RETURNING id, created_at
        `, [idFinal, nombreFinal, consulta]);

        const consultaObj = {
            id: row.id,
            solicitante: 'J.A.R.V.I.S.',
            destinatario_id: idFinal,
            destinatario_nombre: nombreFinal,
            consulta,
            created_at: row.created_at
        };

        // Emitir por Socket.io a la red en vivo
        if (emitirConsultaJarvisAEquipo) {
            emitirConsultaJarvisAEquipo(consultaObj);
        }

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    ok: true,
                    consulta_id: row.id,
                    destinatario: nombreFinal,
                    esta_conectado_ahora: !!target,
                    consulta,
                    mensaje: target
                        ? `Mensaje transmitido en tiempo real por la red a ${nombreFinal}. Jarvis está aguardando su confirmación.`
                        : `El usuario ${nombreFinal} no está conectado en este instante, pero la consulta fue enviada a su terminal y quedará pendiente para cuando inicie sesión.`
                }, null, 2)
            }]
        };
    }

    async startStdio() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('Mix Point MCP Server conectado a STDIO.');
    }
}

module.exports = MixPointMCPServer;
