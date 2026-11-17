require('dotenv').config();
const db = require('../db/pool');

async function diagnostico() {
    console.log('=== DIAGNÓSTICO COMPLETO SISTEMA DE GESTIÓN MIX POINT ===\n');

    // 1. Verificación de Tablas
    console.log('1. Verificando integridad de tablas en PostgreSQL Neon...');
    const tables = await db.all("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
    console.log(`✓ ${tables.length} tablas encontradas en la base de datos:`);
    for (const t of tables) {
        try {
            const count = await db.one(`SELECT count(*) as total FROM "${t.table_name}"`);
            console.log(`   • ${t.table_name.padEnd(25)} : ${count.total} registros`);
        } catch (err) {
            console.error(`   ❌ Error consultando ${t.table_name}:`, err.message);
        }
    }

    // 2. Integridad de Productos y Precios
    console.log('\n2. Verificando consistencia de Catálogo y Precios...');
    const prodStats = await db.one(`
        SELECT 
            count(*) as total,
            count(*) FILTER (WHERE activo = true) as activos,
            count(*) FILTER (WHERE imagen IS NULL OR imagen = '') as sin_imagen,
            count(*) FILTER (WHERE precio_venta <= 0) as sin_precio_venta,
            count(*) FILTER (WHERE stock_actual < 0) as stock_negativo,
            count(*) FILTER (WHERE destacado_carrusel = true) as en_carrusel
        FROM productos
    `);
    console.log('   Estadísticas de productos:', prodStats);

    // 3. Integridad de Lotes vs Stock Actual
    console.log('\n3. Verificando consistencia de Lotes y Stock...');
    const lotesInconsistentes = await db.all(`
        SELECT p.id, p.nombre, p.stock_actual, COALESCE(SUM(l.cantidad_actual), 0) as stock_en_lotes
        FROM productos p
        LEFT JOIN lotes l ON l.producto_id = p.id AND l.cantidad_actual > 0
        WHERE p.activo = true
        GROUP BY p.id, p.nombre, p.stock_actual
        HAVING p.stock_actual > 0 AND COALESCE(SUM(l.cantidad_actual), 0) = 0
        LIMIT 5
    `);
    console.log(`   Productos con stock positivo pero sin lotes asignados: ${lotesInconsistentes.length}`);
    if (lotesInconsistentes.length > 0) {
        console.log('   Ejemplos:', lotesInconsistentes);
    }

    // 4. Verificando Saldo de Clientes vs Movimientos de Cuenta Corriente
    console.log('\n4. Verificando Cuenta Corriente de Clientes...');
    const clientesDesfasados = await db.all(`
        SELECT c.id, c.razon_social, c.saldo_cuenta,
               COALESCE(SUM(
                   CASE 
                       WHEN cc.tipo = 'remito' THEN cc.monto
                       WHEN cc.tipo = 'pago' THEN -cc.monto
                       WHEN cc.tipo = 'ajuste_debito' THEN cc.monto
                       WHEN cc.tipo = 'ajuste_credito' THEN -cc.monto
                       ELSE 0 
                   END
               ), 0) as saldo_calculado
        FROM clientes c
        LEFT JOIN cuenta_corriente_movimientos cc ON cc.cliente_id = c.id
        WHERE c.activo = true
        GROUP BY c.id, c.razon_social, c.saldo_cuenta
        HAVING ABS(c.saldo_cuenta - COALESCE(SUM(
            CASE 
                WHEN cc.tipo = 'remito' THEN cc.monto
                WHEN cc.tipo = 'pago' THEN -cc.monto
                WHEN cc.tipo = 'ajuste_debito' THEN cc.monto
                WHEN cc.tipo = 'ajuste_credito' THEN -cc.monto
                ELSE 0 
            END
        ), 0)) > 0.5
        LIMIT 5
    `);
    console.log(`   Clientes con discrepancia entre saldo y movimientos: ${clientesDesfasados.length}`);

    // 5. Verificando Remitos e Ítems
    console.log('\n5. Verificando Remitos...');
    const remitosHuerfanos = await db.all(`
        SELECT r.id, r.numero, r.total, count(ri.id) as items_count
        FROM remitos r
        LEFT JOIN remito_items ri ON ri.remito_id = r.id
        GROUP BY r.id, r.numero, r.total
        HAVING count(ri.id) = 0 AND r.estado != 'anulado'
        LIMIT 5
    `);
    console.log(`   Remitos activos sin ítems: ${remitosHuerfanos.length}`);

    console.log('\n=== FIN DIAGNÓSTICO ===');
    process.exit(0);
}

diagnostico().catch(err => {
    console.error('Fallo en diagnóstico:', err);
    process.exit(1);
});
