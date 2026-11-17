const { Pool } = require('pg');
require('dotenv').config({ path: 'C:/Users/Usuario/Desktop/frutos-secos-app/backend/.env' });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Mapeo: [duplicado_id] => { canonical_id, transferStock: boolean, nuevoNombre: string|null }
const MERGE_MAP = [
  // 1. Nueces chandler extra light: ID 1 -> ID 2 (MP-800)
  { dupeId: 1, canonicalId: 2, transferStock: false, transferDestacado: true, nuevoNombre: null },
  // 2. Nuez con cascara: ID 242 (MP-355 bogus $53865) -> ID 5 (MP-004 $8280)
  { dupeId: 242, canonicalId: 5, transferStock: false, transferDestacado: false, nuevoNombre: 'Nuez Con Cáscara' },
  // 3. Nuez cuarto: ID 241 (MP-354 $36600, stock 96) -> ID 14 (MP-013 $19200, stock 0)
  { dupeId: 241, canonicalId: 14, transferStock: true, transferDestacado: false, nuevoNombre: 'Nuez Cuarto Extra Light' },
  // 4. Arroz Yamani: ID 72 (MP-073 $7020) -> ID 252 (MP-064 $2800, 6 remitos)
  { dupeId: 72, canonicalId: 252, transferStock: false, transferDestacado: false, nuevoNombre: 'Arroz Yamaní' },
  // 5. Estigma de maiz: ID 147 (MP-222, stock 0) -> ID 268 (MP-209, stock 100)
  { dupeId: 147, canonicalId: 268, transferStock: false, transferDestacado: false, nuevoNombre: 'Estigma de maíz' },
  // 6. Chocolate barra sin azucar: ID 260 (MP-150 $28680) -> ID 156 (MP-157 $21467, 1 remito)
  { dupeId: 260, canonicalId: 156, transferStock: false, transferDestacado: false, nuevoNombre: 'Chocolate barra sin azúcar' },
  // 7. Chocolatinas sin azucar caja x50: ID 161 (MP-162 $5861) -> ID 155 (MP-154 $11940)
  { dupeId: 161, canonicalId: 155, transferStock: false, transferDestacado: false, nuevoNombre: 'Chocolatinas sin azúcar (caja x50unid)' },
  // 8. Gingko Biloba: ID 158 (MP-159) -> ID 165 (MP-166, recepcion)
  { dupeId: 158, canonicalId: 165, transferStock: false, transferDestacado: false, nuevoNombre: 'Gingko Biloba x 1kg' },
  // 9. Graviola: ID 267 (MP-424, stock 0) -> ID 167 (MP-168 $34454, stock 100)
  { dupeId: 267, canonicalId: 167, transferStock: false, transferDestacado: false, nuevoNombre: 'Graviola x 1kg' },
  // 10. Moringa: ID 262 (MP-419, stock 0) -> ID 171 (MP-172 $29837, stock 100)
  { dupeId: 262, canonicalId: 171, transferStock: false, transferDestacado: false, nuevoNombre: 'Moringa x 1kg' },
  // 11. Cascara Sagrada: ID 265 (MP-422, stock 0) -> ID 172 (MP-173 $19536, stock 100)
  { dupeId: 265, canonicalId: 172, transferStock: false, transferDestacado: false, nuevoNombre: 'Cáscara Sagrada x 1kg' },
  // 12. Sem / Sen: ID 264 (MP-421, stock 0) -> ID 166 (MP-167, stock 100)
  { dupeId: 264, canonicalId: 166, transferStock: false, transferDestacado: false, nuevoNombre: 'Sen x 1kg' },
  // 13. Rosa Mosqueta: ID 263 (MP-161 $42166) -> ID 177 (MP-178 $10200)
  { dupeId: 263, canonicalId: 177, transferStock: false, transferDestacado: false, nuevoNombre: 'Rosa Mosqueta x 1kg' },
  // 14. Castañas de la India: ID 266 (MP-164 $12815) -> ID 178 (MP-179 $6026)
  { dupeId: 266, canonicalId: 178, transferStock: false, transferDestacado: false, nuevoNombre: 'Castañas de la India x 1kg' },
  // 15. Rocklets: ID 239 (MP-047, stock 0) -> ID 250 (MP-407, 5 remitos)
  { dupeId: 239, canonicalId: 250, transferStock: false, transferDestacado: false, nuevoNombre: 'Rocklets Aguila' },
  // 16. Nuez moscada en grano duplicada: ID 281 (COD: 355 $53865 stock -1.25)
  // ID 91 es MP-086 "Nuez Moscada Molida" $12960. ID 281 fue un item de prueba con código 355.
  // La desactivamos para limpiar el catálogo.
  { dupeId: 281, canonicalId: null, transferStock: false, transferDestacado: false, nuevoNombre: null }
];

async function runMigration() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('Iniciando migración de unificación de productos duplicados...');

    for (const item of MERGE_MAP) {
      const { dupeId, canonicalId, transferStock, transferDestacado, nuevoNombre } = item;

      const dupe = (await client.query('SELECT * FROM productos WHERE id = $1', [dupeId])).rows[0];
      if (!dupe) {
        console.warn(`Producto duplicado ID ${dupeId} no existe, saltando.`);
        continue;
      }

      if (canonicalId) {
        const canonical = (await client.query('SELECT * FROM productos WHERE id = $1', [canonicalId])).rows[0];
        if (!canonical) {
          console.error(`Producto canónico ID ${canonicalId} no existe! Saltando ${dupeId}`);
          continue;
        }

        console.log(`\n-> Unificando [ID ${dupeId}] "${dupe.nombre}" => [ID ${canonicalId}] "${canonical.nombre}"`);

        // 1. Reasignar remito_items
        const r1 = await client.query('UPDATE remito_items SET producto_id = $1 WHERE producto_id = $2', [canonicalId, dupeId]);
        if (r1.rowCount > 0) console.log(`   Reasignados ${r1.rowCount} remito_items`);

        // 2. Reasignar recepcion_items
        const r2 = await client.query('UPDATE recepcion_items SET producto_id = $1 WHERE producto_id = $2', [canonicalId, dupeId]);
        if (r2.rowCount > 0) console.log(`   Reasignados ${r2.rowCount} recepcion_items`);

        // 3. Reasignar movimientos_stock
        const r3 = await client.query('UPDATE movimientos_stock SET producto_id = $1 WHERE producto_id = $2', [canonicalId, dupeId]);
        if (r3.rowCount > 0) console.log(`   Reasignados ${r3.rowCount} movimientos_stock`);

        // 4. Reasignar lotes
        const r4 = await client.query('UPDATE lotes SET producto_id = $1 WHERE producto_id = $2', [canonicalId, dupeId]);
        if (r4.rowCount > 0) console.log(`   Reasignados ${r4.rowCount} lotes`);

        // 5. Transferir stock si corresponde
        if (transferStock) {
          const dupeStock = Number(dupe.stock_actual) || 0;
          if (dupeStock > 0) {
            await client.query('UPDATE productos SET stock_actual = stock_actual + $1 WHERE id = $2', [dupeStock, canonicalId]);
            console.log(`   Stock transferido: +${dupeStock} al canónico ID ${canonicalId}`);
          }
        }

        // 6. Transferir carrusel si el duplicado lo tenía
        if (transferDestacado && dupe.destacado_carrusel) {
          await client.query(`
            UPDATE productos 
            SET destacado_carrusel = true, 
                badge_carrusel = COALESCE(badge_carrusel, $1), 
                orden_carrusel = COALESCE(orden_carrusel, $2) 
            WHERE id = $3
          `, [dupe.badge_carrusel || '✨ SELECCIÓN', dupe.orden_carrusel || 3, canonicalId]);
          console.log(`   Destacado en carrusel transferido a ID ${canonicalId}`);
        }

        // 7. Actualizar nombre canónico si corresponde
        if (nuevoNombre) {
          await client.query('UPDATE productos SET nombre = $1 WHERE id = $2', [nuevoNombre, canonicalId]);
          console.log(`   Nombre actualizado a: "${nuevoNombre}"`);
        }
      }

      // 8. Desactivar el duplicado
      await client.query('UPDATE productos SET activo = false, stock_actual = 0, destacado_carrusel = false WHERE id = $1', [dupeId]);
      console.log(`   [ID ${dupeId}] Desactivado (activo = false).`);
    }

    await client.query('COMMIT');
    console.log('\n¡MIGRACIÓN COMPLETADA EXITOSAMENTE! Todos los duplicados fueron unificados y desactivados.');

    // Conteo final de activos
    const finalCount = (await client.query('SELECT COUNT(*) as c FROM productos WHERE activo = true')).rows[0].c;
    console.log(`\nTotal final de productos ACTIVOS en catálogo: ${finalCount}`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error durante la migración, rollback ejecutado:', err);
  } finally {
    client.release();
    pool.end();
  }
}

runMigration().catch(console.error);
