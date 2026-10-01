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

        const existente = await db.one('SELECT id, stock_actual FROM productos WHERE LOWER(nombre) = LOWER($1) OR (codigo IS NOT NULL AND codigo = $2)', [nombre, codigo]);

        let prodId;
        if (existente) {
            prodId = existente.id;
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
            `, [codigo, catId, descripcion, imagen, unidadMedida, precio1kg, precio5kg, precio10kg, precio25kg, precio30kg, precioCompra, prodId]);
            actualizados++;
        } else {
            const { row } = await db.run(`
                INSERT INTO productos (
                    codigo, nombre, descripcion, imagen, categoria_id, unidad_medida,
                    precio_compra, precio_venta, precio_5kg, precio_10kg, precio_25kg, precio_30kg,
                    stock_minimo, stock_actual, activo
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 20, 100, true)
                RETURNING id
            `, [codigo, nombre, descripcion, imagen, catId, unidadMedida, precioCompra, precio1kg, precio5kg, precio10kg, precio25kg, precio30kg]);
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

/**
 * Envía datos hacia un Google Apps Script desplegado como Web App (Push Mix Point -> Google Sheets)
 */
async function pushToGoogleSheets(scriptUrl, payload) {
    if (!scriptUrl) return { ok: false, error: 'URL de Google Apps Script no configurada.' };

    try {
        const response = await fetch(scriptUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            redirect: 'follow'
        });

        const contentType = response.headers.get('content-type') || '';
        let data;
        if (contentType.includes('application/json')) {
            data = await response.json();
        } else {
            const text = await response.text();
            data = { ok: response.ok, raw: text.slice(0, 300) };
        }

        return { ok: response.ok, data };
    } catch (err) {
        console.error('Error enviando datos a Google Sheets:', err.message);
        return { ok: false, error: err.message };
    }
}

/**
 * Ejecuta una sincronización bidireccional completa:
 * 1. Lee configuración de BD
 * 2. Inbound: Lee catálogo y pedidos desde Google Sheets
 * 3. Outbound: Envía stocks actuales a Google Sheets si hay Web App configurada
 * 4. Guarda registro en sync_logs
 */
async function sincronizarBidireccional(options = {}) {
    const logs = [];
    const inicio = Date.now();
    let estadoGeneral = 'exito';

    try {
        // Obtener configuraciones de BD
        const cfgRows = await db.all("SELECT clave, valor FROM configuracion_sistema WHERE clave IN ('sheets_catalogo_url', 'sheets_pedidos_url', 'sheets_script_url')");
        const cfg = {};
        cfgRows.forEach(r => { cfg[r.clave] = r.valor; });

        const catalogoUrl = options.catalogo_url || cfg.sheets_catalogo_url || process.env.GOOGLE_SHEET_CATALOGO_URL;
        const scriptUrl = options.script_url || cfg.sheets_script_url || process.env.GOOGLE_SHEET_SCRIPT_URL;

        let resCatalogo = null;
        if (catalogoUrl) {
            try {
                resCatalogo = await sincronizarCatalogo(catalogoUrl);
                logs.push(`Catálogo importado: ${resCatalogo.nuevos} nuevos, ${resCatalogo.actualizados} actualizados.`);
            } catch (err) {
                logs.push(`Error importando catálogo: ${err.message}`);
                estadoGeneral = 'advertencia';
            }
        }

        // Outbound: Push de stock actual hacia Google Sheets si hay Apps Script configurado
        let resPush = null;
        if (scriptUrl) {
            try {
                const productos = await db.all(`
                    SELECT p.id, p.codigo, p.nombre, p.stock_actual, p.precio_venta, p.unidad_medida, c.nombre as categoria
                    FROM productos p
                    LEFT JOIN categorias_producto c ON c.id = p.categoria_id
                    WHERE p.activo = true
                    ORDER BY p.id ASC
                `);

                resPush = await pushToGoogleSheets(scriptUrl, {
                    accion: 'ACTUALIZAR_STOCK_Y_PRECIOS',
                    timestamp: new Date().toISOString(),
                    total_productos: productos.length,
                    productos: productos.map(p => ({
                        id: p.id,
                        codigo: p.codigo,
                        nombre: p.nombre,
                        stock: Number(p.stock_actual),
                        precio_venta: Number(p.precio_venta),
                        unidad: p.unidad_medida,
                        categoria: p.categoria || ''
                    }))
                });

                if (resPush.ok) {
                    logs.push(`Sincronización saliente hacia Google Sheets exitosa (${productos.length} productos sincronizados).`);
                } else {
                    logs.push(`Aviso en push a Google Sheets: ${resPush.error || 'Respuesta no confirmada'}`);
                }
            } catch (err) {
                logs.push(`Error en push a Google Sheets: ${err.message}`);
                estadoGeneral = 'advertencia';
            }
        }

        const duracion = ((Date.now() - inicio) / 1000).toFixed(2);
        const detalles = JSON.stringify({
            duracion_segundos: duracion,
            catalogo: resCatalogo,
            push: resPush,
            logs
        });

        await db.run(`
            INSERT INTO sync_logs (tipo, resultado, detalles, fecha)
            VALUES ('bidireccional', $1, $2, NOW())
        `, [estadoGeneral, detalles]);

        return {
            ok: true,
            estado: estadoGeneral,
            duracion: `${duracion}s`,
            logs,
            resCatalogo,
            resPush
        };
    } catch (err) {
        console.error('Error en sincronización bidireccional:', err);
        await db.run(`
            INSERT INTO sync_logs (tipo, resultado, detalles, fecha)
            VALUES ('bidireccional', 'error', $1, NOW())
        `, [JSON.stringify({ error: err.message, logs })]);

        throw err;
    }
}

/**
 * Genera el código de Google Apps Script listo para pegar en el Google Sheet del cliente
 */
function obtenerCodigoAppsScript(backendUrl = 'https://tu-servidor-mixpoint.com', webhookSecret = 'MIXPOINT_SECRET_KEY') {
    return `/**
 * =========================================================================
 * CONECTOR OFICIAL MIX POINT - GOOGLE SHEETS (SINCRONIZACIÓN BIDIRECCIONAL)
 * =========================================================================
 * 
 * INSTRUCCIONES DE INSTALACIÓN:
 * 1. En tu Google Sheet, ve a: Extensiones > Apps Script.
 * 2. Borra el código existente y pega este archivo completo.
 * 3. En la constante BACKEND_URL pon la URL de tu servidor Mix Point.
 * 4. Ve a "Implementar" > "Nueva implementación" > Tipo: "Aplicación web".
 *    - Ejecutar como: "Yo" (tu cuenta)
 *    - Quién tiene acceso: "Cualquier persona" (permite a Mix Point actualizar el Sheet)
 * 5. Haz clic en "Implementar", copia la URL generada y pégala en Mix Point en
 *    "Configuración de Sincronización".
 * 6. Vuelve a tu hoja de cálculo y actualiza la página: ¡verás el menú "🌱 Mix Point"!
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
    .addItem("🔄 Sincronizar Todo Ahora", "sincronizarTodoManual")
    .addItem("📦 Enviar Pedidos Pendientes", "enviarPedidosPendientes")
    .addSeparator()
    .addItem("🩺 Probar Conexión con Mix Point", "probarConexion")
    .addToUi();
}

/**
 * Webhook Receptor: Mix Point llama a esta función cuando hay ventas o ajustes
 * y actualiza automáticamente los stocks en la hoja de cálculo.
 */
function doPost(e) {
  try {
    const rawData = e.postData.contents;
    const body = JSON.parse(rawData);
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    if (body.accion === "ACTUALIZAR_STOCK_Y_PRECIOS") {
      const hoja = ss.getSheetByName(CONFIG.HOJA_CATALOGO) || ss.getSheets()[0];
      const data = hoja.getDataRange().getValues();
      if (data.length < 2) return ContentService.createTextOutput(JSON.stringify({ ok: true, msg: "Hoja vacia" }));

      const headers = data[0].map(h => String(h).trim().toLowerCase());
      const colNombre = headers.indexOf("nombre");
      const colId = headers.indexOf("id");
      const colStock = headers.indexOf("stock") !== -1 ? headers.indexOf("stock") : headers.indexOf("stock_actual");

      if (colStock !== -1 && body.productos && Array.isArray(body.productos)) {
        const prodMap = {};
        body.productos.forEach(p => {
          if (p.nombre) prodMap[p.nombre.toLowerCase().trim()] = p.stock;
          if (p.codigo) prodMap[p.codigo.toLowerCase().trim()] = p.stock;
        });

        for (let i = 1; i < data.length; i++) {
          const nombreRow = String(data[i][colNombre] || "").toLowerCase().trim();
          const idRow = colId !== -1 ? String(data[i][colId] || "").toLowerCase().trim() : "";
          
          if (prodMap[nombreRow] !== undefined) {
            hoja.getRange(i + 1, colStock + 1).setValue(prodMap[nombreRow]);
          } else if (idRow && prodMap[idRow] !== undefined) {
            hoja.getRange(i + 1, colStock + 1).setValue(prodMap[idRow]);
          }
        }
      }

      return ContentService.createTextOutput(JSON.stringify({ ok: true, mensaje: "Stock actualizado con éxito en Sheet" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ ok: true, mensaje: "Evento recibido" }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Trigger al editar: si se carga un pedido o cambia el catálogo, notifica a Mix Point
 */
function onEdit(e) {
  try {
    const range = e.range;
    const sheet = range.getSheet();
    const sheetName = sheet.getName();

    // Solo notificar si se edita en Pedidos o Catálogo
    if (sheetName !== CONFIG.HOJA_PEDIDOS && sheetName !== CONFIG.HOJA_CATALOGO) return;

    const row = range.getRow();
    if (row === 1) return; // ignorar encabezados

    // Notificar al backend de Mix Point
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
 * Enviar todos los pedidos de la hoja a Mix Point manualmente
 */
function enviarPedidosPendientes() {
  const ui = SpreadsheetApp.getUi();
  try {
    const response = UrlFetchApp.fetch(CONFIG.BACKEND_URL + "/api/integraciones/sync-bidireccional", {
      method: "post",
      contentType: "application/json",
      headers: { "x-mixpoint-token": CONFIG.SECRET_TOKEN },
      muteHttpExceptions: true
    });

    const resJson = JSON.parse(response.getContentText());
    if (resJson.ok) {
      ui.alert("✅ Mix Point Sincronizado", "La sincronización se completó correctamente.\\n" + (resJson.logs || []).join("\\n"), ui.ButtonSet.OK);
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
    ui.alert("🟢 Conexión Exitosa", "Servidor Mix Point respondiendo OK (Código: " + response.getResponseCode() + ")", ui.ButtonSet.OK);
  } catch (err) {
    ui.alert("🔴 Error", "No se pudo conectar: " + err.toString(), ui.ButtonSet.OK);
  }
}

function sincronizarTodoManual() {
  enviarPedidosPendientes();
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
    sincronizarBidireccional,
    obtenerCodigoAppsScript
};
