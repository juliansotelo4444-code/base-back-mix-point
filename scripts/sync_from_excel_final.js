const https = require('https');
const { Pool } = require('pg');
require('dotenv').config({ path: 'C:/Users/Usuario/Desktop/frutos-secos-app/backend/.env' });

const agent = new https.Agent({ rejectUnauthorized: false });

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { agent }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchUrl(res.headers.location));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
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

function sanitizarNumero(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  let s = String(val).trim().replace(/[^0-9.,-]/g, '');
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

function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/por\s*1\s*kg|po\s*1\s*kg|x\s*1\s*kg|x1kg|1kg/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

async function getUniqueCode(client, baseCode) {
  let code = baseCode;
  let counter = 1;
  while (true) {
    const exists = await client.query('SELECT id FROM productos WHERE codigo = $1', [code]);
    if (exists.rows.length === 0) return code;
    code = `${baseCode}-${counter++}`;
  }
}

async function executeFinalSync() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    console.log('Iniciando sincronización definitiva desde el Excel...');

    // 1. Liberar códigos de productos inactivos para evitar choques de constraint
    await client.query(`
      UPDATE productos 
      SET codigo = codigo || '-OLD-' || id 
      WHERE activo = false 
        AND codigo IS NOT NULL 
        AND codigo NOT LIKE '%-OLD-%'
    `);

    const url = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTsSl1udCka3CKz61sitiiwynsibWeGS65K9zEe-6UXdCb_k1W8_Nr0ABoIZm_7wIvHbWd13KKOqOiI/pub?gid=120010130&single=true&output=csv';
    const csvContent = await fetchUrl(url);
    const sheetRows = parseCSV(csvContent);
    console.log(`Filas leídas de Excel: ${sheetRows.length}`);

    const dbProds = (await client.query('SELECT * FROM productos ORDER BY id ASC')).rows;
    const categorias = (await client.query('SELECT * FROM categorias_producto')).rows;
    const catMap = {};
    categorias.forEach(c => { catMap[norm(c.nombre)] = c.id; });

    let updatedCount = 0;
    let insertedCount = 0;
    let priceDiffs = 0;
    const processedActiveIds = new Set();

    for (const r of sheetRows) {
      const nombre = r.nombre ? r.nombre.trim() : '';
      if (!nombre) continue;

      const rNorm = norm(nombre);
      const rId = parseInt(r.id, 10);
      const codeFromId = r.id ? 'MP-' + String(r.id).padStart(3, '0') : null;

      let precio1kg = sanitizarNumero(r.kg);
      const precio5kg = sanitizarNumero(r.cincoKg);
      const precio10kg = sanitizarNumero(r.diezKg);
      const precio25kg = sanitizarNumero(r.veinticincoKg);
      const precio30kg = sanitizarNumero(r.treintaKg);

      if (precio1kg === 0 && precio5kg > 0) {
        precio1kg = precio5kg;
      }

      // Priority match among active products
      let dbP = dbProds.find(p => p.activo && norm(p.nombre) === rNorm);
      if (!dbP && codeFromId) {
        dbP = dbProds.find(p => p.activo && p.codigo === codeFromId);
      }
      if (!dbP && rId) {
        dbP = dbProds.find(p => p.activo && p.id === rId);
      }

      // Caso especial: nuez moscada en grano (ID 281)
      if (!dbP && rNorm === 'nuezmoscadaengrano') {
        dbP = dbProds.find(p => p.id === 281);
      }

      if (dbP) {
        // Evitar procesar el mismo producto dos veces si el Sheet tiene duplicados
        if (processedActiveIds.has(dbP.id)) {
          console.log(`[DUPLICADO EN EXCEL SALTEADO]: "${nombre}" (ya mapeado a ID ${dbP.id})`);
          continue;
        }
        processedActiveIds.add(dbP.id);

        const oldPrice = Number(dbP.precio_venta) || 0;
        if (precio1kg > 0 && oldPrice !== precio1kg) {
          priceDiffs++;
        }

        const catId = r.categoria && catMap[norm(r.categoria)] ? catMap[norm(r.categoria)] : dbP.categoria_id;
        const costo = Number(dbP.precio_compra) > 0 ? Number(dbP.precio_compra) : Math.round(precio1kg * 0.70);

        await client.query(`
          UPDATE productos 
          SET precio_venta = COALESCE(NULLIF($1, 0), precio_venta),
              precio_5kg = $2,
              precio_10kg = $3,
              precio_25kg = $4,
              precio_30kg = $5,
              precio_compra = $6,
              categoria_id = COALESCE($7, categoria_id),
              activo = true,
              updated_at = NOW()
          WHERE id = $8
        `, [precio1kg, precio5kg, precio10kg, precio25kg, precio30kg, costo, catId, dbP.id]);

        updatedCount++;
      } else {
        // Producto nuevo en Sheet no presente en DB
        let catId = r.categoria && catMap[norm(r.categoria)] ? catMap[norm(r.categoria)] : null;
        if (!catId && r.categoria) {
          const { rows } = await client.query('INSERT INTO categorias_producto (nombre) VALUES ($1) ON CONFLICT (nombre) DO UPDATE SET nombre = EXCLUDED.nombre RETURNING id', [r.categoria.trim()]);
          catId = rows[0].id;
          catMap[norm(r.categoria)] = catId;
        }
        const baseCod = codeFromId || `MP-${r.id || 999}`;
        const uniqueCod = await getUniqueCode(client, baseCod);
        const costo = Math.round(precio1kg * 0.70);

        await client.query(`
          INSERT INTO productos (
            codigo, nombre, descripcion, imagen, categoria_id, unidad_medida,
            precio_compra, precio_venta, precio_5kg, precio_10kg, precio_25kg, precio_30kg,
            stock_minimo, stock_actual, activo, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, 'kg',
            $6, $7, $8, $9, $10, $11,
            20, 100, true, NOW(), NOW()
          )
        `, [uniqueCod, nombre, r.descripcion || null, r.imagen || null, catId, costo, precio1kg, precio5kg, precio10kg, precio25kg, precio30kg]);

        console.log(`[INSERTADO NUEVO PRODUCTO]: COD:${uniqueCod} "${nombre}" ($${precio1kg})`);
        insertedCount++;
      }
    }

    // Asegurar que ID 281 (nuez moscada en grano) quede activo con código MP-355
    await client.query("UPDATE productos SET activo = true, codigo = 'MP-355' WHERE id = 281");

    await client.query('COMMIT');
    console.log('\n¡TRANSACCIÓN COMPLETADA EXITOSAMENTE EN NEON DB!');

    console.log(`\nResumen de actualización:`);
    console.log(`- Productos del catálogo actualizados con precios de Excel: ${updatedCount}`);
    console.log(`- Precios modificados respecto a la versión anterior: ${priceDiffs}`);
    console.log(`- Nuevos productos creados desde el Excel: ${insertedCount}`);

    const finalActivos = (await client.query('SELECT COUNT(*) as c FROM productos WHERE activo = true')).rows[0].c;
    console.log(`\nTotal final de productos ACTIVOS únicos en base de datos: ${finalActivos}`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error durante la sincronización:', err);
  } finally {
    client.release();
    pool.end();
  }
}

executeFinalSync().catch(console.error);
