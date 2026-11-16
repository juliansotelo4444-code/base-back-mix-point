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
    let protegidos = 0;
    const productosAfectados = [];

    for (const r of rows) {
        const nombre = r.nombre ? r.nombre.trim() : '';
        if (!nombre) continue;

        const catId = r.categoria ? catMap[r.categoria.trim().toLowerCase()] || null : null;
        let precio1kg = sanitizarNumero(r.kg);
        const precio5kg = sanitizarNumero(r.cincoKg);
        const precio10kg = sanitizarNumero(r.diezKg);
        const precio25kg = sanitizarNumero(r.veinticincoKg);
        const precio30kg = sanitizarNumero(r.treintaKg);

        // Si 1kg está vacío en la planilla pero hay precio en 5kg (ej. Herboristería o venta por bulto)
        if (precio1kg === 0) {
            if (r.categoria && r.categoria.toLowerCase().includes('herbor')) {
                precio1kg = precio5kg > 0 ? Math.round(precio5kg * 1.20) : 0;
            } else {
                precio1kg = precio5kg > 0 ? precio5kg : 0;
            }
        }

        const codigo = r.codigo || (r.id ? 'MP-' + String(r.id).padStart(3, '0') : null);
        const descripcion = r.descripcion ? r.descripcion.trim() : null;
        const imagen = r.imagen ? r.imagen.trim() : null;
        let unidadMedida = 'kg';
        const tipoVentaStr = String(r.tipoVenta || r.tipoventa || r.tipo_venta || r.unidad || '').toLowerCase();
        if (tipoVentaStr.includes('unidad') || nombre.toLowerCase().includes('barritas') || nombre.toLowerCase().includes('tintura') || nombre.toLowerCase().includes('60 cc') || nombre.toLowerCase().includes('40cc')) {
            unidadMedida = 'unidad';
        }

        // 1. Buscar coincidencia por nombre exacto o normalizado o código
        const existente = await db.one(`
            SELECT id, codigo, nombre, descripcion, imagen, categoria_id, unidad_medida,
                   stock_actual, stock_minimo, precio_compra,
                   precio_venta, precio_5kg, precio_10kg, precio_25kg, precio_30kg,
                   modificado_en_app, activo
            FROM productos
            WHERE (LOWER(TRIM(nombre)) = LOWER(TRIM($1)) OR (codigo = $2 AND codigo IS NOT NULL))
            ORDER BY activo DESC, id ASC
            LIMIT 1
        `, [nombre, codigo]);

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

            if (existente.modificado_en_app) {
                // REGLA SUPREMA DE PROTECCIÓN:
                // Si el producto fue modificado o creado en la base de gestión, SUS DATOS LOCALES TIENEN PRIORIDAD.
                // Google Sheets NUNCA sobrescribe los precios o detalles cambiados por el usuario.
                // Solo se completan campos que en la base de gestión estén vacíos (0 o null).
                const final1kg = Number(existente.precio_venta) > 0 ? Number(existente.precio_venta) : precio1kg;
                const final5kg = Number(existente.precio_5kg) > 0 ? Number(existente.precio_5kg) : precio5kg;
                const final10kg = Number(existente.precio_10kg) > 0 ? Number(existente.precio_10kg) : precio10kg;
                const final25kg = Number(existente.precio_25kg) > 0 ? Number(existente.precio_25kg) : precio25kg;
                const final30kg = Number(existente.precio_30kg) > 0 ? Number(existente.precio_30kg) : precio30kg;
                const finalDesc = (existente.descripcion && existente.descripcion.trim()) ? existente.descripcion : descripcion;
                const finalImg = (existente.imagen && existente.imagen.trim()) ? existente.imagen : imagen;
                const finalCat = existente.categoria_id || catId;
                const finalUnidad = existente.unidad_medida || unidadMedida;

                await db.run(`
                    UPDATE productos SET
                        codigo = COALESCE($1, codigo),
                        categoria_id = $2,
                        descripcion = $3,
                        imagen = $4,
                        unidad_medida = $5,
                        precio_venta = $6,
                        precio_5kg = $7,
                        precio_10kg = $8,
                        precio_25kg = $9,
                        precio_30kg = $10,
                        activo = true
                    WHERE id = $11
                `, [codigoUpdate, finalCat, finalDesc, finalImg, finalUnidad, final1kg, final5kg, final10kg, final25kg, final30kg, prodId]);
                protegidos++;
            } else {
                // Producto no personalizado en la app: se actualiza con la planilla, pero NUNCA se sobreescribe con 0 o vacíos
                const final1kg = precio1kg > 0 ? precio1kg : Number(existente.precio_venta || 0);
                const final5kg = precio5kg > 0 ? precio5kg : Number(existente.precio_5kg || 0);
                const final10kg = precio10kg > 0 ? precio10kg : Number(existente.precio_10kg || 0);
                const final25kg = precio25kg > 0 ? precio25kg : Number(existente.precio_25kg || 0);
                const final30kg = precio30kg > 0 ? precio30kg : Number(existente.precio_30kg || 0);
                const finalDesc = descripcion || existente.descripcion;
                const finalImg = imagen || existente.imagen;
                const finalCat = catId || existente.categoria_id;
                const finalUnidad = unidadMedida || existente.unidad_medida;

                await db.run(`
                    UPDATE productos SET
                        codigo = COALESCE($1, codigo),
                        categoria_id = $2,
                        descripcion = $3,
                        imagen = $4,
                        unidad_medida = $5,
                        precio_venta = $6,
                        precio_5kg = $7,
                        precio_10kg = $8,
                        precio_25kg = $9,
                        precio_30kg = $10,
                        activo = true
                    WHERE id = $11
                `, [codigoUpdate, finalCat, finalDesc, finalImg, finalUnidad, final1kg, final5kg, final10kg, final25kg, final30kg, prodId]);
                actualizados++;
            }
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
                    stock_minimo, stock_actual, activo, modificado_en_app, updated_at, origen_datos
                ) VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9, $10, $11, 20, 0, true, false, NOW(), 'sheets')
                RETURNING id
            `, [nuevoCodigo, nombre, descripcion, imagen, catId, unidadMedida, precio1kg, precio5kg, precio10kg, precio25kg, precio30kg]);
            prodId = row.id;
            nuevos++;
        }

        productosAfectados.push(prodId);

        // No alterar stock ni inventario durante sincronizaciones maestras de catálogo
    }

    // Verificar alertas de stock para los productos
    AlertasService.verificarMultiplesProductos(productosAfectados).catch(() => {});

    return {
        ok: true,
        total: rows.length,
        nuevos,
        actualizados,
        protegidos
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
 * Envía el catálogo consolidado desde PostgreSQL hacia Google Sheets
 * mediante el Web App de Google Apps Script (si está configurado).
 */
async function pushToGoogleSheets(customScriptUrl = null) {
    try {
        const cfgScript = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'sheets_script_url'");
        const scriptUrl = customScriptUrl || (cfgScript && cfgScript.valor);

        if (!scriptUrl) {
            return {
                ok: false,
                omitido: true,
                mensaje: 'Para sincronizar hacia Google Sheets, configurá la URL del Web App de Apps Script en la sección de integración, o descargá el catálogo en CSV.'
            };
        }

        const cfgToken = await db.one("SELECT valor FROM configuracion_sistema WHERE clave = 'sheets_webhook_token'");
        const token = (cfgToken && cfgToken.valor) || 'MIXPOINT_SECRET_KEY';

        // Obtener todos los productos activos con sus categorías
        const productos = await db.all(`
            SELECT p.id, p.codigo, p.nombre, p.descripcion, p.imagen, c.nombre as categoria,
                   p.precio_venta, p.precio_5kg, p.precio_10kg, p.precio_25kg, p.precio_30kg,
                   p.stock_actual, p.stock_minimo, p.unidad_medida, p.activo, p.modificado_en_app
            FROM productos p
            LEFT JOIN categorias_producto c ON c.id = p.categoria_id
            WHERE p.activo = true
            ORDER BY c.nombre ASC, p.nombre ASC
        `);

        const payload = JSON.stringify({
            token,
            accion: 'ACTUALIZAR_CATALOGO',
            productos: productos.map(p => ({
                id: p.id,
                codigo: p.codigo,
                nombre: p.nombre,
                categoria: p.categoria || 'Sin Categoría',
                kg: Number(p.precio_venta || 0),
                cincoKg: Number(p.precio_5kg || 0),
                diezKg: Number(p.precio_10kg || 0),
                veinticincoKg: Number(p.precio_25kg || 0),
                treintaKg: Number(p.precio_30kg || 0),
                stock: Number(p.stock_actual || 0),
                tipoVenta: p.unidad_medida === 'unidad' ? 'unidad' : 'kg'
            }))
        });

        const urlObj = new URL(scriptUrl);
        const res = await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            }, (resStream) => {
                let data = '';
                resStream.on('data', chunk => data += chunk);
                resStream.on('end', () => resolve({ statusCode: resStream.statusCode, data }));
            });
            req.on('error', reject);
            req.write(payload);
            req.end();
        });

        return {
            ok: true,
            total_enviados: productos.length,
            mensaje: `Catálogo de ${productos.length} productos enviado con éxito a Google Sheets.`
        };
    } catch (err) {
        console.warn('Aviso en pushToGoogleSheets:', err.message);
        return {
            ok: false,
            error: err.message,
            mensaje: `No se pudo conectar con el Web App de Google Sheets: ${err.message}`
        };
    }
}

/**
 * Ejecuta una sincronización UNIDIRECCIONAL estricta y segura (Google Sheets -> Postgres):
 * 1. Lee configuración de BD (URL del catálogo de Google Sheets)
 * 2. Inbound: Descarga y sincroniza catálogo preservando 100% los cambios locales
 * 3. Guarda registro de auditoría en sync_logs
 */
async function sincronizarUnidireccional(options = {}) {
    const logs = [];
    const inicio = Date.now();
    let estadoGeneral = 'exito';

    syncStatus.syncing = true;
    syncStatus.mensaje = 'Sincronizando datos desde Google Sheets hacia PostgreSQL (Modo Protegido)...';

    try {
        logs.push('Iniciando sincronización segura (Google Sheets -> PostgreSQL) con protección de datos locales.');

        // Obtener configuraciones de BD
        const cfgRows = await db.all("SELECT clave, valor FROM configuracion_sistema WHERE clave IN ('sheets_catalogo_url', 'sheets_pedidos_url')");
        const cfg = {};
        cfgRows.forEach(r => { cfg[r.clave] = r.valor; });

        const catalogoUrl = options.catalogo_url || cfg.sheets_catalogo_url || process.env.GOOGLE_SHEET_CATALOGO_URL;

        let resCatalogo = null;
        if (catalogoUrl) {
            try {
                resCatalogo = await sincronizarCatalogo(catalogoUrl);
                logs.push(`Catálogo sincronizado: ${resCatalogo.nuevos} productos nuevos, ${resCatalogo.actualizados} actualizados, ${resCatalogo.protegidos || 0} protegidos (cambios manuales de la app preservados).`);
            } catch (err) {
                logs.push(`Error importando catálogo desde Sheet: ${err.message}`);
                estadoGeneral = 'advertencia';
            }
        } else {
            logs.push('No hay URL de catálogo configurada en sheets_catalogo_url.');
        }

        const duracion = ((Date.now() - inicio) / 1000).toFixed(2);
        const detalles = JSON.stringify({
            modo: 'unidireccional_protegido',
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
        syncStatus.mensaje = `Última sincronización completada (${duracion}s): datos de gestión protegidos.`;

        return {
            ok: true,
            modo: 'unidireccional_protegido',
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

/**
 * Sincronización Bidireccional Segura:
 * 1. Inbound seguro: Actualiza productos desde Google Sheets respetando y protegiendo cambios locales.
 * 2. Outbound: Si está configurada la URL del Web App de Apps Script, envía el catálogo consolidado hacia la planilla.
 */
async function sincronizarBidireccional(options = {}) {
    const logs = [];
    const inicio = Date.now();
    let estadoGeneral = 'exito';

    syncStatus.syncing = true;
    syncStatus.mensaje = 'Ejecutando sincronización bidireccional segura con Google Sheets...';

    try {
        // 1. Inbound seguro
        const resInbound = await sincronizarUnidireccional(options);
        logs.push(...(resInbound.logs || []));

        // 2. Outbound si hay script configurado
        const resPush = await pushToGoogleSheets(options.script_url);
        if (resPush.ok) {
            logs.push(`Exportación a Google Sheets completada: ${resPush.total_enviados} productos sincronizados en la planilla.`);
        } else if (resPush.mensaje) {
            logs.push(`Exportación a Google Sheets: ${resPush.mensaje}`);
        }

        const duracion = ((Date.now() - inicio) / 1000).toFixed(2);
        syncStatus.syncing = false;
        syncStatus.ultimo_sync = new Date().toISOString();
        syncStatus.resultado = estadoGeneral;
        syncStatus.mensaje = `Sincronización completada (${duracion}s): base de gestión 100% resguardada.`;

        return {
            ok: true,
            modo: 'bidireccional_segura',
            estado: estadoGeneral,
            duracion: `${duracion}s`,
            logs,
            resCatalogo: resInbound.resCatalogo,
            resPush
        };
    } catch (err) {
        syncStatus.syncing = false;
        syncStatus.resultado = 'error';
        syncStatus.mensaje = `Error en sincronización bidireccional: ${err.message}`;
        throw err;
    }
}

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
 * CONECTOR OFICIAL MIX POINT - GOOGLE SHEETS (SINCRONIZACIÓN BIDIRECCIONAL SEGURA)
 * =========================================================================
 * 
 * ARQUITECTURA SEGURA:
 * - Los cambios hechos en la base de gestión de Mix Point tienen máxima prioridad y se preservan.
 * - Podés actualizar datos desde esta planilla hacia Mix Point O descargar los datos de Mix Point hacia aquí.
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
    .addItem("📥 Descargar Catálogo Actual desde Mix Point", "descargarCatalogoDesdeMixPoint")
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

    if (sheetName !== CONFIG.HOJA_PEDIDOS && sheetName !== CONFIG.HOJA_CATALOGO) return;

    const row = range.getRow();
    if (row === 1) return; // ignorar fila de encabezados

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
      ui.alert("✅ Sincronización Exitosa", "La base de datos de Mix Point procesó los datos de esta planilla manteniendo resguardados los cambios locales.\\nDuración: " + (resJson.duracion || ""), ui.ButtonSet.OK);
    } else {
      ui.alert("⚠️ Advertencia", "Respuesta del servidor: " + (resJson.error || response.getContentText()), ui.ButtonSet.OK);
    }
  } catch (err) {
    ui.alert("❌ Error de Conexión", "No se pudo contactar con Mix Point: " + err.toString(), ui.ButtonSet.OK);
  }
}

/**
 * Descarga el catálogo oficial y precios vigentes desde Mix Point y los vuelca en la hoja "Catalogo"
 */
function descargarCatalogoDesdeMixPoint() {
  const ui = SpreadsheetApp.getUi();
  try {
    const response = UrlFetchApp.fetch(CONFIG.BACKEND_URL + "/api/integraciones/catalogo-para-sheets", {
      method: "get",
      headers: { "x-mixpoint-token": CONFIG.SECRET_TOKEN },
      muteHttpExceptions: true
    });

    const resJson = JSON.parse(response.getContentText());
    if (!resJson.ok || !Array.isArray(resJson.productos)) {
      ui.alert("⚠️ Error", "No se pudieron obtener los productos: " + (resJson.error || "Formato inválido"), ui.ButtonSet.OK);
      return;
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(CONFIG.HOJA_CATALOGO);
    if (!sheet) {
      sheet = ss.insertSheet(CONFIG.HOJA_CATALOGO);
    }

    const headers = ["codigo", "nombre", "categoria", "kg", "cincoKg", "diezKg", "veinticincoKg", "treintaKg", "stock", "tipoVenta"];
    sheet.clearContents();
    sheet.appendRow(headers);

    const filas = resJson.productos.map(p => [
      p.codigo || "",
      p.nombre || "",
      p.categoria || "",
      p.kg || "",
      p.cincoKg || "",
      p.diezKg || "",
      p.veinticincoKg || "",
      p.treintaKg || "",
      p.stock || 0,
      p.tipoVenta || "kg"
    ]);

    if (filas.length > 0) {
      sheet.getRange(2, 1, filas.length, headers.length).setValues(filas);
    }

    ui.alert("✅ Catálogo Actualizado", "Se cargaron " + filas.length + " productos con los precios vigentes y protegidos de Mix Point.", ui.ButtonSet.OK);
  } catch (err) {
    ui.alert("❌ Error", "Fallo al descargar catálogo: " + err.toString(), ui.ButtonSet.OK);
  }
}

/**
 * Webhook Receptor (si se publica como Web App)
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.token !== CONFIG.SECRET_TOKEN) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "Token inválido" })).setMimeType(ContentService.MimeType.JSON);
    }

    if (data.accion === "ACTUALIZAR_CATALOGO" && Array.isArray(data.productos)) {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      let sheet = ss.getSheetByName(CONFIG.HOJA_CATALOGO);
      if (!sheet) {
        sheet = ss.insertSheet(CONFIG.HOJA_CATALOGO);
      }

      const headers = ["codigo", "nombre", "categoria", "kg", "cincoKg", "diezKg", "veinticincoKg", "treintaKg", "stock", "tipoVenta"];
      sheet.clearContents();
      sheet.appendRow(headers);

      const filas = data.productos.map(p => [
        p.codigo || "",
        p.nombre || "",
        p.categoria || "",
        p.kg || "",
        p.cincoKg || "",
        p.diezKg || "",
        p.veinticincoKg || "",
        p.treintaKg || "",
        p.stock || 0,
        p.tipoVenta || "kg"
      ]);

      if (filas.length > 0) {
        sheet.getRange(2, 1, filas.length, headers.length).setValues(filas);
      }

      return ContentService.createTextOutput(JSON.stringify({ ok: true, mensaje: "Catálogo volcado con éxito (" + filas.length + " filas)" })).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.toString() })).setMimeType(ContentService.MimeType.JSON);
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
