const https = require('https');
const db = require('../db/pool');
const AlertasService = require('./alertasService');

const agent = new https.Agent({ rejectUnauthorized: false });

function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { agent }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(fetchUrl(res.headers.location));
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`Error al acceder al Google Sheet: HTTP ${res.statusCode}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

function parseCSVLine(text) {
    const result = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            if (inQuotes && text[i + 1] === '"') {
                cur += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (c === ',' && !inQuotes) {
            result.push(cur);
            cur = '';
        } else {
            cur += c;
        }
    }
    result.push(cur);
    return result;
}

function parseCSV(content) {
    const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length === 0) return [];
    
    const headers = parseCSVLine(lines[0]);
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const values = parseCSVLine(line);
        const row = {};
        headers.forEach((h, idx) => {
            row[h.trim()] = values[idx] !== undefined ? values[idx].trim() : '';
        });
        rows.push(row);
    }
    return rows;
}

function extraerSheetId(url) {
    if (!url) return null;
    const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return match ? match[1] : null;
}

function sanitizarNumero(val) {
    if (val === null || val === undefined) return 0;
    if (typeof val === 'number') return isNaN(val) ? 0 : val;
    let s = String(val).trim();
    s = s.replace(/[^0-9.,-]/g, '');
    if (!s) return 0;
    if (s.includes('.') && s.includes(',')) {
        s = s.replace(/\./g, '').replace(',', '.');
    } else if (s.includes('.')) {
        const parts = s.split('.');
        if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) {
            s = s.replace(/\./g, '');
        }
    } else if (s.includes(',')) {
        const parts = s.split(',');
        if (parts.length === 2 && parts[1].length !== 3) {
            s = s.replace(',', '.');
        } else {
            s = s.replace(/,/g, '');
        }
    }
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
}

/**
 * Sincroniza el catálogo de productos desde un Google Sheet CSV
 */
async function sincronizarCatalogo(sheetUrl) {
    const sheetId = extraerSheetId(sheetUrl);
    if (!sheetId) throw new Error('URL de Google Sheets inválida.');

    const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
    const csvContent = await fetchUrl(exportUrl);
    const rows = parseCSV(csvContent);

    if (rows.length === 0) {
        throw new Error('El archivo de Google Sheets está vacío o no tiene encabezados válidos.');
    }

    // 1. Obtener categorías existentes
    const categoriasExistentes = await db.all('SELECT id, nombre FROM categorias_producto');
    const catMap = {};
    categoriasExistentes.forEach(c => {
        catMap[c.nombre.toLowerCase()] = c.id;
    });

    // Crear categorías nuevas si existen en el Sheet
    for (const r of rows) {
        const catName = r.categoria ? r.categoria.trim() : '';
        if (catName && !catMap[catName.toLowerCase()]) {
            const { row } = await db.run('INSERT INTO categorias_producto (nombre) VALUES ($1) ON CONFLICT (nombre) DO UPDATE SET nombre = EXCLUDED.nombre RETURNING id', [catName]);
            catMap[catName.toLowerCase()] = row.id;
        }
    }

    const admin = await db.one("SELECT id FROM usuarios WHERE rol = 'admin' LIMIT 1");
    const adminId = admin ? admin.id : null;

    let nuevos = 0;
    let actualizados = 0;
    const productosAfectados = [];

    for (const r of rows) {
        const nombre = r.nombre ? r.nombre.trim() : '';
        if (!nombre) continue;

        const catId = r.categoria ? catMap[r.categoria.trim().toLowerCase()] || null : null;
        const precio1kg = sanitizarNumero(r.kg);
        const precio5kg = sanitizarNumero(r.cincoKg) || (precio1kg > 0 ? Math.round(precio1kg * 0.95) : 0);
        const precio10kg = sanitizarNumero(r.diezKg) || (precio5kg > 0 ? Math.round(precio5kg * 0.95) : 0);
        const precio25kg = sanitizarNumero(r.veinticincoKg) || (precio10kg > 0 ? Math.round(precio10kg * 0.92) : 0);
        const precio30kg = sanitizarNumero(r.treintaKg) || (precio25kg > 0 ? Math.round(precio25kg * 0.95) : 0);
        const precioCompra = Math.round(precio1kg * 0.70);
        const codigo = r.id ? 'MP-' + String(r.id).padStart(3, '0') : null;
        const descripcion = r.descripcion || null;
        const imagen = r.imagen || null;
        const unidadMedida = (r.tipoVenta && r.tipoVenta.toLowerCase().includes('unidad')) ? 'unidad' : 'kg';

        // 1. Buscar coincidencia por nombre exacto o normalizado
        const existente = await db.one('SELECT id, codigo, stock_actual FROM productos WHERE LOWER(nombre) = LOWER($1)', [nombre]);

        let prodId;
        if (existente) {
            prodId = existente.id;
            let codigoUpdate = existente.codigo;
            if (codigo && codigo !== existente.codigo) {
                const ocupado = await db.one('SELECT id FROM productos WHERE codigo = $1 AND id != $2', [codigo, prodId]);
                if (!ocupado) {
                    codigoUpdate = codigo;
                }
            }

            await db.run(`
                UPDATE productos SET
                    codigo = COALESCE($1, codigo),
                    categoria_id = COALESCE($2, categoria_id),
                    descripcion = COALESCE($3, descripcion),
                    imagen = COALESCE($4, imagen),
                    unidad_medida = $5,
                    precio_venta = $6,
                    precio_5kg = $7,
                    precio_10kg = $8,
                    precio_25kg = $9,
                    precio_30kg = $10,
                    precio_compra = $11,
                    stock_actual = GREATEST(stock_actual, 100),
                    activo = true
                WHERE id = $12
            `, [codigoUpdate, catId, descripcion, imagen, unidadMedida, precio1kg, precio5kg, precio10kg, precio25kg, precio30kg, precioCompra, prodId]);
            actualizados++;
        } else {
            let nuevoCodigo = codigo;
            if (nuevoCodigo) {
                const ocupado = await db.one('SELECT id FROM productos WHERE codigo = $1', [nuevoCodigo]);
                if (ocupado) {
                    const maxCodRow = await db.one(`SELECT COALESCE(MAX(NULLIF(regexp_replace(codigo, '[^0-9]', '', 'g'), '')::bigint), 0) as max_num FROM productos`);
                    nuevoCodigo = 'MP-' + String(Number(maxCodRow.max_num) + 1).padStart(3, '0');
                }
            } else {
                const maxCodRow = await db.one(`SELECT COALESCE(MAX(NULLIF(regexp_replace(codigo, '[^0-9]', '', 'g'), '')::bigint), 0) as max_num FROM productos`);
                nuevoCodigo = 'MP-' + String(Number(maxCodRow.max_num) + 1).padStart(3, '0');
            }

            const { row } = await db.run(`
                INSERT INTO productos (
                    codigo, nombre, descripcion, imagen, categoria_id, unidad_medida,
                    precio_compra, precio_venta, precio_5kg, precio_10kg, precio_25kg, precio_30kg,
                    stock_minimo, stock_actual, activo
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 20, 100, true)
                RETURNING id
            `, [nuevoCodigo, nombre, descripcion, imagen, catId, unidadMedida, precioCompra, precio1kg, precio5kg, precio10kg, precio25kg, precio30kg]);
            prodId = row.id;
            nuevos++;
        }

        productosAfectados.push(prodId);

        // Asegurar que tenga lote con fecha de vencimiento adecuada
        const loteExistente = await db.one('SELECT id FROM lotes WHERE producto_id = $1 AND cantidad_actual > 0', [prodId]);
        if (!loteExistente) {
            const loteNum = `LOT-${String(prodId).padStart(3, '0')}-2026`;
            const { row: loteRow } = await db.run(`
                INSERT INTO lotes (
                    producto_id, numero_lote, fecha_ingreso, fecha_vencimiento,
                    cantidad_inicial, cantidad_actual, costo_unitario
                ) VALUES ($1, $2, CURRENT_DATE, '2027-12-31', 100, 100, $3)
                RETURNING id
            `, [prodId, loteNum, precioCompra]);

            await db.run(`
                INSERT INTO movimientos_stock (producto_id, lote_id, tipo, cantidad, motivo, referencia_tipo, usuario_id)
                VALUES ($1, $2, 'ingreso', 100, 'Sincronización Google Sheets', 'ajuste', $3)
            `, [prodId, loteRow.id, adminId]);
        }
    }

    // Verificar alertas de stock para los productos
    AlertasService.verificarMultiplesProductos(productosAfectados).catch(() => {});

    return {
        ok: true,
        total: rows.length,
        nuevos,
        actualizados
    };
}

// Estado en memoria de sincronización para consulta inmediata desde la interfaz web
let syncStatus = {
    syncing: false,
    ultimo_sync: null,
    resultado: 'idle',
    mensaje: 'Listo para sincronizar desde Google Sheets',
    tipo: 'unidireccional'
};

function getSyncStatus() {
    return syncStatus;
}

/**
 * Función saliente deshabilitada por diseño arquitectónico:
 * Mix Point opera en modo SINCRONIZACIÓN UNIDIRECCIONAL ESTRICTA.
 * La base de datos PostgreSQL NUNCA modifica, altera ni sobrescribe las planillas de Google Sheets.
 */
async function pushToGoogleSheets() {
    console.warn('[Mix Point Security] Intento de push a Google Sheets bloqueado: la arquitectura es estrictamente unidireccional (Sheets -> Postgres).');
    return {
        ok: false,
        prohibido: true,
        mensaje: 'Flujo saliente bloqueado: Google Sheets es la única interfaz de entrada de datos y nunca recibe modificaciones desde la base de datos.'
    };
}

/**
 * Ejecuta una sincronización UNIDIRECCIONAL estricta (Google Sheets -> Postgres):
 * 1. Lee configuración de BD (URL del catálogo de Google Sheets)
 * 2. Inbound: Descarga y sincroniza catálogo de productos y lotes en PostgreSQL
 * 3. Prohíbe cualquier escritura saliente hacia Google Sheets
 * 4. Guarda registro de auditoría en sync_logs
 */
async function sincronizarUnidireccional(options = {}) {
    const logs = [];
    const inicio = Date.now();
    let estadoGeneral = 'exito';

    syncStatus.syncing = true;
    syncStatus.mensaje = 'Sincronizando datos desde Google Sheets hacia PostgreSQL...';

    try {
        logs.push('Iniciando sincronización unidireccional estricta (Google Sheets -> PostgreSQL).');

        // Obtener configuraciones de BD
        const cfgRows = await db.all("SELECT clave, valor FROM configuracion_sistema WHERE clave IN ('sheets_catalogo_url', 'sheets_pedidos_url')");
        const cfg = {};
        cfgRows.forEach(r => { cfg[r.clave] = r.valor; });

        const catalogoUrl = options.catalogo_url || cfg.sheets_catalogo_url || process.env.GOOGLE_SHEET_CATALOGO_URL;

        let resCatalogo = null;
        if (catalogoUrl) {
            try {
                resCatalogo = await sincronizarCatalogo(catalogoUrl);
                logs.push(`Catálogo importado con éxito: ${resCatalogo.nuevos} productos nuevos, ${resCatalogo.actualizados} actualizados.`);
            } catch (err) {
                logs.push(`Error importando catálogo desde Sheet: ${err.message}`);
                estadoGeneral = 'advertencia';
            }
        } else {
            logs.push('No hay URL de catálogo configurada en sheets_catalogo_url.');
        }

        // Regla estricta: No se realiza ningún push hacia Google Sheets
        logs.push('Flujo saliente omitido: La base de datos no altera Google Sheets (Unidireccionalidad asegurada).');

        const duracion = ((Date.now() - inicio) / 1000).toFixed(2);
        const detalles = JSON.stringify({
            modo: 'unidireccional_estricto',
            duracion_segundos: duracion,
            catalogo: resCatalogo,
            logs
        });

        await db.run(`
            INSERT INTO sync_logs (tipo, resultado, detalles, fecha)
            VALUES ('unidireccional', $1, $2, NOW())
        `, [estadoGeneral, detalles]);

        syncStatus.syncing = false;
        syncStatus.ultimo_sync = new Date().toISOString();
        syncStatus.resultado = estadoGeneral;
        syncStatus.mensaje = `Última sincronización completada (${duracion}s): ${estadoGeneral === 'exito' ? 'Correcta' : 'Con avisos'}`;

        return {
            ok: true,
            modo: 'unidireccional_estricto',
            estado: estadoGeneral,
            duracion: `${duracion}s`,
            logs,
            resCatalogo
        };
    } catch (err) {
        syncStatus.syncing = false;
        syncStatus.resultado = 'error';
        syncStatus.mensaje = `Error en sincronización: ${err.message}`;

        console.error('Error en sincronización unidireccional:', err);
        await db.run(`
            INSERT INTO sync_logs (tipo, resultado, detalles, fecha)
            VALUES ('unidireccional', 'error', $1, NOW())
        `, [JSON.stringify({ error: err.message, logs })]);

        throw err;
    }
}

// Alias de retrocompatibilidad
const sincronizarBidireccional = sincronizarUnidireccional;

/**
 * Genera el código de Google Apps Script listo para pegar en el Google Sheet del cliente
 */
/**
 * Genera el código de Google Apps Script listo para pegar en el Google Sheet del cliente
 * Modo: Sincronización Unidireccional Estricta (Google Sheets -> Postgres)
 */
function obtenerCodigoAppsScript(backendUrl = 'https://tu-servidor-mixpoint.com', webhookSecret = 'MIXPOINT_SECRET_KEY') {
    return `/**
 * =========================================================================
 * CONECTOR OFICIAL MIX POINT - GOOGLE SHEETS (SINCRONIZACIÓN UNIDIRECCIONAL)
 * =========================================================================
 * 
 * ARQUITECTURA: UNIDIRECCIONAL ESTRICTA
 * - Esta planilla es la ÚNICA interfaz de carga de datos para el operador.
 * - Toda modificación se refleja inmediatamente en el sistema web de Mix Point.
 * - La base de datos NO altera ni sobrescribe las celdas de esta planilla.
 * 
 * INSTRUCCIONES DE INSTALACIÓN:
 * 1. En esta hoja de cálculo ve a: Extensiones > Apps Script.
 * 2. Borra el código existente y pega este archivo completo.
 * 3. Guarda el proyecto (Ctrl + S / Cmd + S).
 * 4. Actualiza la pestaña de la planilla en el navegador: ¡verás el menú "🌱 Mix Point"!
 */

const CONFIG = {
  BACKEND_URL: "${backendUrl}",
  SECRET_TOKEN: "${webhookSecret}",
  HOJA_PEDIDOS: "Pedidos",
  HOJA_CATALOGO: "Catalogo"
};

/**
 * Crea el menú personalizado en la barra de herramientas al abrir la hoja
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu("🌱 Mix Point")
    .addItem("🔄 Sincronizar hacia Mix Point Ahora", "sincronizarTodoManual")
    .addSeparator()
    .addItem("🩺 Probar Conexión con Mix Point", "probarConexion")
    .addToUi();
}

/**
 * Trigger al editar: cuando el operador carga o modifica un pedido o el catálogo,
 * notifica al servidor de Mix Point para sincronización en segundo plano sin latencia.
 */
function onEdit(e) {
  try {
    const range = e.range;
    const sheet = range.getSheet();
    const sheetName = sheet.getName();

    // Solo notificar si se edita en Pedidos o Catálogo
    if (sheetName !== CONFIG.HOJA_PEDIDOS && sheetName !== CONFIG.HOJA_CATALOGO) return;

    const row = range.getRow();
    if (row === 1) return; // ignorar fila de encabezados

    // Notificar al webhook seguro de Mix Point
    const payload = {
      evento: sheetName === CONFIG.HOJA_PEDIDOS ? "PEDIDO_EDITADO" : "CATALOGO_EDITADO",
      fila: row,
      columna: range.getColumn(),
      valor: range.getValue(),
      timestamp: new Date().toISOString()
    };

    UrlFetchApp.fetch(CONFIG.BACKEND_URL + "/api/integraciones/sheets-webhook", {
      method: "post",
      contentType: "application/json",
      headers: { "x-mixpoint-token": CONFIG.SECRET_TOKEN },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log("Error en onEdit: " + err.toString());
  }
}

/**
 * Disparar sincronización inmediata hacia Mix Point
 */
function sincronizarTodoManual() {
  const ui = SpreadsheetApp.getUi();
  try {
    const response = UrlFetchApp.fetch(CONFIG.BACKEND_URL + "/api/integraciones/sync-unidireccional", {
      method: "post",
      contentType: "application/json",
      headers: { "x-mixpoint-token": CONFIG.SECRET_TOKEN },
      muteHttpExceptions: true
    });

    const resJson = JSON.parse(response.getContentText());
    if (resJson.ok) {
      ui.alert("✅ Sincronización Exitosa", "La base de datos de Mix Point se actualizó con los datos de esta planilla.\\nDuración: " + (resJson.duracion || ""), ui.ButtonSet.OK);
    } else {
      ui.alert("⚠️ Advertencia", "Respuesta del servidor: " + (resJson.error || response.getContentText()), ui.ButtonSet.OK);
    }
  } catch (err) {
    ui.alert("❌ Error de Conexión", "No se pudo contactar con Mix Point: " + err.toString(), ui.ButtonSet.OK);
  }
}

/**
 * Prueba de conexión
 */
function probarConexion() {
  const ui = SpreadsheetApp.getUi();
  try {
    const response = UrlFetchApp.fetch(CONFIG.BACKEND_URL + "/api/health", { muteHttpExceptions: true });
    ui.alert("🟢 Conexión Exitosa", "Servidor Mix Point respondiendo correctamente (Código HTTP: " + response.getResponseCode() + ")", ui.ButtonSet.OK);
  } catch (err) {
    ui.alert("🔴 Error", "No se pudo conectar con Mix Point: " + err.toString(), ui.ButtonSet.OK);
  }
}
`;
}

module.exports = {
    fetchUrl,
    parseCSV,
    parseCSVLine,
    extraerSheetId,
    sanitizarNumero,
    sincronizarCatalogo,
    pushToGoogleSheets,
    sincronizarUnidireccional,
    sincronizarBidireccional,
    obtenerCodigoAppsScript,
    getSyncStatus
};
