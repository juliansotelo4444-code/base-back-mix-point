-- =========================================================
-- BASE DE DATOS - SISTEMA DE GESTIÓN PARA EMPRESA DE FRUTOS SECOS
-- Versión PostgreSQL (compatible con Neon, Supabase, Render, etc.)
-- =========================================================

-- ---------------------------------------------------------
-- USUARIOS Y ROLES
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios (
    id              SERIAL PRIMARY KEY,
    nombre          TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    rol             TEXT NOT NULL CHECK (rol IN ('admin','ventas','deposito','administracion')) DEFAULT 'ventas',
    activo          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------
-- CLIENTES Y PROVEEDORES
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS clientes (
    id              SERIAL PRIMARY KEY,
    razon_social    TEXT NOT NULL,
    cuit            TEXT,
    condicion_iva   TEXT DEFAULT 'Consumidor Final',
    direccion       TEXT,
    localidad       TEXT,
    telefono        TEXT,
    email           TEXT,
    lista_precio    TEXT DEFAULT 'general',
    saldo_cuenta    NUMERIC NOT NULL DEFAULT 0,
    observaciones   TEXT,
    activo          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS proveedores (
    id              SERIAL PRIMARY KEY,
    razon_social    TEXT NOT NULL,
    cuit            TEXT,
    condicion_iva   TEXT DEFAULT 'Responsable Inscripto',
    direccion       TEXT,
    localidad       TEXT,
    telefono        TEXT,
    email           TEXT,
    saldo_cuenta    NUMERIC NOT NULL DEFAULT 0,
    observaciones   TEXT,
    activo          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------
-- PRODUCTOS, LOTES (TRAZABILIDAD) Y STOCK
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS categorias_producto (
    id      SERIAL PRIMARY KEY,
    nombre  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS productos (
    id                  SERIAL PRIMARY KEY,
    codigo              TEXT UNIQUE,
    nombre              TEXT NOT NULL,
    descripcion         TEXT,
    imagen              TEXT,
    categoria_id        INTEGER REFERENCES categorias_producto(id),
    unidad_medida       TEXT NOT NULL DEFAULT 'kg' CHECK (unidad_medida IN ('kg','g','unidad','bolsa','caja')),
    precio_compra       NUMERIC NOT NULL DEFAULT 0,
    precio_venta        NUMERIC NOT NULL DEFAULT 0,
    precio_5kg          NUMERIC NOT NULL DEFAULT 0,
    precio_10kg         NUMERIC NOT NULL DEFAULT 0,
    precio_25kg         NUMERIC NOT NULL DEFAULT 0,
    precio_30kg         NUMERIC NOT NULL DEFAULT 0,
    stock_minimo        NUMERIC NOT NULL DEFAULT 0,
    stock_actual        NUMERIC NOT NULL DEFAULT 0,
    activo              BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Migraciones idempotentes para tablas existentes
ALTER TABLE productos ADD COLUMN IF NOT EXISTS descripcion TEXT;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS imagen TEXT;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS precio_5kg NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS precio_10kg NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS precio_25kg NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS precio_30kg NUMERIC NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS recepciones (
    id                      SERIAL PRIMARY KEY,
    numero                  TEXT UNIQUE NOT NULL,
    proveedor_id            INTEGER NOT NULL REFERENCES proveedores(id),
    fecha                   DATE NOT NULL DEFAULT CURRENT_DATE,
    numero_remito_proveedor TEXT,
    numero_factura          TEXT,
    estado                  TEXT NOT NULL DEFAULT 'confirmada' CHECK (estado IN ('borrador','confirmada','anulada')),
    observaciones           TEXT,
    total                   NUMERIC NOT NULL DEFAULT 0,
    usuario_id              INTEGER REFERENCES usuarios(id),
    created_at              TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Lotes: permite trazabilidad y control de vencimientos (clave en frutos secos)
CREATE TABLE IF NOT EXISTS lotes (
    id                  SERIAL PRIMARY KEY,
    producto_id         INTEGER NOT NULL REFERENCES productos(id),
    numero_lote         TEXT,
    proveedor_id        INTEGER REFERENCES proveedores(id),
    fecha_ingreso       DATE NOT NULL DEFAULT CURRENT_DATE,
    fecha_vencimiento   DATE,
    cantidad_inicial    NUMERIC NOT NULL,
    cantidad_actual     NUMERIC NOT NULL,
    costo_unitario      NUMERIC NOT NULL DEFAULT 0,
    recepcion_id        INTEGER REFERENCES recepciones(id),
    created_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Kardex: historial de todos los movimientos de stock, para auditoría
CREATE TABLE IF NOT EXISTS movimientos_stock (
    id              SERIAL PRIMARY KEY,
    producto_id     INTEGER NOT NULL REFERENCES productos(id),
    lote_id         INTEGER REFERENCES lotes(id),
    tipo            TEXT NOT NULL CHECK (tipo IN ('ingreso','egreso','ajuste_positivo','ajuste_negativo','merma')),
    cantidad        NUMERIC NOT NULL,
    motivo          TEXT,
    referencia_tipo TEXT,
    referencia_id   INTEGER,
    usuario_id      INTEGER REFERENCES usuarios(id),
    fecha           TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------
-- RECEPCIÓN DE MERCADERÍA (ítems)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS recepcion_items (
    id              SERIAL PRIMARY KEY,
    recepcion_id    INTEGER NOT NULL REFERENCES recepciones(id) ON DELETE CASCADE,
    producto_id     INTEGER NOT NULL REFERENCES productos(id),
    lote_id         INTEGER REFERENCES lotes(id),
    cantidad        NUMERIC NOT NULL,
    precio_unitario NUMERIC NOT NULL DEFAULT 0,
    subtotal        NUMERIC NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------
-- REMITOS (envíos / entregas a clientes)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS remitos (
    id                  SERIAL PRIMARY KEY,
    numero              TEXT UNIQUE NOT NULL,
    cliente_id          INTEGER NOT NULL REFERENCES clientes(id),
    fecha               DATE NOT NULL DEFAULT CURRENT_DATE,
    direccion_entrega   TEXT,
    estado              TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','entregado','facturado','anulado')),
    transportista       TEXT,
    observaciones       TEXT,
    total               NUMERIC NOT NULL DEFAULT 0,
    usuario_id          INTEGER REFERENCES usuarios(id),
    created_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS remito_items (
    id              SERIAL PRIMARY KEY,
    remito_id       INTEGER NOT NULL REFERENCES remitos(id) ON DELETE CASCADE,
    producto_id     INTEGER NOT NULL REFERENCES productos(id),
    lote_id         INTEGER REFERENCES lotes(id),
    cantidad        NUMERIC NOT NULL,
    precio_unitario NUMERIC NOT NULL DEFAULT 0,
    subtotal        NUMERIC NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------
-- GASTOS GENERALES
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS categorias_gasto (
    id          SERIAL PRIMARY KEY,
    nombre      TEXT NOT NULL UNIQUE,
    descripcion TEXT
);

CREATE TABLE IF NOT EXISTS gastos (
    id                  SERIAL PRIMARY KEY,
    numero              TEXT UNIQUE NOT NULL,
    categoria_id        INTEGER NOT NULL REFERENCES categorias_gasto(id),
    proveedor_id        INTEGER REFERENCES proveedores(id),
    fecha               DATE NOT NULL DEFAULT CURRENT_DATE,
    descripcion         TEXT NOT NULL,
    monto               NUMERIC NOT NULL,
    metodo_pago         TEXT DEFAULT 'efectivo' CHECK (metodo_pago IN ('efectivo','transferencia','tarjeta','cheque','otro')),
    numero_comprobante  TEXT,
    usuario_id          INTEGER REFERENCES usuarios(id),
    created_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------
-- CUENTA CORRIENTE - PAGOS Y COBROS
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS movimientos_cuenta (
    id              SERIAL PRIMARY KEY,
    entidad_tipo    TEXT NOT NULL CHECK (entidad_tipo IN ('cliente','proveedor')),
    entidad_id      INTEGER NOT NULL,
    tipo            TEXT NOT NULL CHECK (tipo IN ('cobro','pago','ajuste','cargo')),
    monto           NUMERIC NOT NULL,
    medio_pago      TEXT DEFAULT 'efectivo',
    referencia_tipo TEXT,
    referencia_id   INTEGER,
    observaciones   TEXT,
    usuario_id      INTEGER REFERENCES usuarios(id),
    fecha           TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------
-- ÍNDICES
-- ---------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_productos_nombre ON productos(LOWER(nombre));
CREATE INDEX IF NOT EXISTS idx_productos_categoria ON productos(categoria_id);
CREATE INDEX IF NOT EXISTS idx_productos_activo ON productos(activo);
CREATE INDEX IF NOT EXISTS idx_lotes_producto ON lotes(producto_id);
CREATE INDEX IF NOT EXISTS idx_lotes_vencimiento ON lotes(fecha_vencimiento);
CREATE INDEX IF NOT EXISTS idx_lotes_fefo ON lotes(producto_id, cantidad_actual, fecha_vencimiento);
CREATE INDEX IF NOT EXISTS idx_mov_stock_producto ON movimientos_stock(producto_id);
CREATE INDEX IF NOT EXISTS idx_mov_stock_fecha ON movimientos_stock(fecha DESC);
CREATE INDEX IF NOT EXISTS idx_remitos_numero ON remitos(numero);
CREATE INDEX IF NOT EXISTS idx_remitos_cliente ON remitos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_remitos_fecha ON remitos(fecha DESC);
CREATE INDEX IF NOT EXISTS idx_remito_items_remito ON remito_items(remito_id);
CREATE INDEX IF NOT EXISTS idx_remito_items_producto ON remito_items(producto_id);
CREATE INDEX IF NOT EXISTS idx_recepciones_numero ON recepciones(numero);
CREATE INDEX IF NOT EXISTS idx_recepciones_proveedor ON recepciones(proveedor_id);
CREATE INDEX IF NOT EXISTS idx_recepciones_fecha ON recepciones(fecha DESC);
CREATE INDEX IF NOT EXISTS idx_recepcion_items_recepcion ON recepcion_items(recepcion_id);
CREATE INDEX IF NOT EXISTS idx_recepcion_items_producto ON recepcion_items(producto_id);
CREATE INDEX IF NOT EXISTS idx_gastos_fecha ON gastos(fecha DESC);
CREATE INDEX IF NOT EXISTS idx_gastos_categoria ON gastos(categoria_id);
CREATE INDEX IF NOT EXISTS idx_mov_cuenta_entidad ON movimientos_cuenta(entidad_tipo, entidad_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_clientes_nombre ON clientes(LOWER(razon_social));
CREATE INDEX IF NOT EXISTS idx_proveedores_nombre ON proveedores(LOWER(razon_social));
