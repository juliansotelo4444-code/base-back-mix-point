const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
    throw new Error('Falta la variable de entorno DATABASE_URL. Definila en .env (ver .env.example).');
}

// Neon/Render y la mayoría de proveedores cloud de Postgres requieren SSL.
// Para una base local (desarrollo) no hace falta: se puede desactivar con PGSSL=false en .env
const useSSL = process.env.PGSSL !== 'false';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
});

// Helpers para no repetir `.rows` / `.rows[0]` en cada ruta.
// Mantienen una API parecida a la que usábamos con better-sqlite3, pero async.
async function query(text, params = []) {
    return pool.query(text, params);
}

async function one(text, params = []) {
    const { rows } = await pool.query(text, params);
    return rows[0] || null;
}

async function all(text, params = []) {
    const { rows } = await pool.query(text, params);
    return rows;
}

// Para INSERT/UPDATE/DELETE. Si el SQL termina en RETURNING, devuelve la fila resultante.
async function run(text, params = []) {
    const { rows, rowCount } = await pool.query(text, params);
    return { rows, rowCount, row: rows[0] || null };
}

// Corre varias operaciones dentro de una misma transacción.
// `fn` recibe un cliente con los mismos helpers (query/one/all/run) atado a esa transacción.
async function transaction(fn) {
    const client = await pool.connect();
    const scoped = {
        query: (text, params = []) => client.query(text, params),
        one: async (text, params = []) => (await client.query(text, params)).rows[0] || null,
        all: async (text, params = []) => (await client.query(text, params)).rows,
        run: async (text, params = []) => {
            const { rows, rowCount } = await client.query(text, params);
            return { rows, rowCount, row: rows[0] || null };
        },
    };
    try {
        await client.query('BEGIN');
        const result = await fn(scoped);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// Aplica el esquema (CREATE TABLE IF NOT EXISTS ...) al arrancar el servidor.
async function initSchema() {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
}

module.exports = { pool, query, one, all, run, transaction, initSchema };
