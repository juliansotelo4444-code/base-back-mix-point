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

function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/por\s*1\s*kg|po\s*1\s*kg|x\s*1\s*kg|x1kg|1kg/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

async function fixDescriptions() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    console.log('--- CORRIGIENDO DESCRIPCIONES CORRIDAS / ERRÓNEAS ---');

    // 1. Obtener todas las filas del Sheet
    const url = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTsSl1udCka3CKz61sitiiwynsibWeGS65K9zEe-6UXdCb_k1W8_Nr0ABoIZm_7wIvHbWd13KKOqOiI/pub?gid=120010130&single=true&output=csv';
    const csvContent = await fetchUrl(url);
    const sheetRows = parseCSV(csvContent);

    // Mapeo: norm(nombre) => descripcion oficial del Sheet
    const descMap = {};
    sheetRows.forEach(r => {
      const nombre = (r.nombre || '').trim();
      const desc = (r.descripcion || '').trim();
      if (nombre && desc) {
        descMap[norm(nombre)] = desc;
      }
    });

    console.log(`Descripciones oficiales encontradas en el Sheet: ${Object.keys(descMap).length}`);

    // 2. Limpiar primero las descripciones corridas de todos los productos en DB
    await client.query("UPDATE productos SET descripcion = NULL");
    console.log('Descripciones previas reseteadas a NULL.');

    // 3. Aplicar ÚNICAMENTE las descripciones oficiales que coinciden exactamente con el producto correcto
    const dbProds = (await client.query('SELECT id, codigo, nombre FROM productos WHERE activo = true')).rows;
    let asignadas = 0;

    for (const p of dbProds) {
      const k = norm(p.nombre);
      if (descMap[k]) {
        await client.query('UPDATE productos SET descripcion = $1 WHERE id = $2', [descMap[k], p.id]);
        console.log(`[OK ASIGNADO] [ID ${p.id}] "${p.nombre}" ===> "${descMap[k]}"`);
        asignadas++;
      }
    }

    await client.query('COMMIT');
    console.log(`\n¡CORRECCIÓN COMPLETADA! Se asignaron ${asignadas} descripciones a sus productos legítimos.`);

    // Verificar las que antes estaban mal
    console.log('\n--- VERIFICACIÓN DE PRODUCTOS QUE ESTABAN CORRIDOS ---');
    const checkIds = [2, 21, 22, 23, 24, 25, 27, 28, 29, 40, 124, 125];
    const checks = (await client.query(`SELECT id, codigo, nombre, descripcion FROM productos WHERE id = ANY($1) ORDER BY id`, [checkIds])).rows;
    checks.forEach(c => console.log(`[ID ${c.id}] "${c.nombre}" => DESC: ${c.descripcion ? `"${c.descripcion}"` : '(null / limpio)'}`));

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al corregir descripciones:', err);
  } finally {
    client.release();
    pool.end();
  }
}

fixDescriptions().catch(console.error);
