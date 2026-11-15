
-- ═══════════════════════════════════════════════════════════════════════
-- AAVORA.ART — SAFE ADDITIVE MIGRATION
-- Updated for the verified existing aavora-db schema
--
-- IMPORTANT:
-- 1. Run statements ONE AT A TIME in Cloudflare D1 Console.
-- 2. Run STEP 1 and STEP 0b first.
-- 3. Do not run STEP 2 onward until all STOP checks are clear.
-- 4. Never ignore an unexpected SQL error.
-- 5. No DROP TABLE, DROP COLUMN, or DELETE of existing records.
-- 6. Keep the Time Travel recovery Bookmark ID saved.
-- ═══════════════════════════════════════════════════════════════════════


-- ─── STEP 1 — DIAGNOSTICS (READ ONLY) ─────────────────────────────────

SELECT name
FROM sqlite_master
WHERE type = 'table'
ORDER BY name;

PRAGMA table_info(products);
PRAGMA table_info(orders);
PRAGMA table_info(order_items);
PRAGMA table_info(admin_users);
PRAGMA table_info(admin_sessions);
PRAGMA table_info(product_reviews);
PRAGMA table_info(order_status_history);

-- Record these BEFORE counts separately.

SELECT COUNT(*) AS products_before FROM products;

SELECT COUNT(*) AS orders_before FROM orders;

SELECT COUNT(*) AS order_items_before FROM order_items;

SELECT COUNT(*) AS admin_users_before FROM admin_users;

SELECT COUNT(*) AS admin_sessions_before FROM admin_sessions;


-- ─── STEP 0b-A — INCOMPATIBLE EXISTING COLUMN TYPES ───────────────────
-- Any returned row = STOP.

SELECT
  'H1-incompatible-type' AS hazard,
  'product_reviews' AS tbl,
  name,
  type AS actual
FROM pragma_table_info('product_reviews')
WHERE
  (
    name IN ('id','product_id','reviewer_name','review_text','review_date')
    AND type <> ''
    AND type NOT LIKE '%CHAR%'
    AND type NOT LIKE '%TEXT%'
    AND type NOT LIKE '%CLOB%'
  )
  OR
  (
    name IN ('rating','is_visible','created_at','updated_at')
    AND type <> ''
    AND type NOT LIKE '%INT%'
  )

UNION ALL

SELECT
  'H1-incompatible-type',
  'order_status_history',
  name,
  type
FROM pragma_table_info('order_status_history')
WHERE
  (
    name IN ('id','order_id','status','note')
    AND type <> ''
    AND type NOT LIKE '%CHAR%'
    AND type NOT LIKE '%TEXT%'
    AND type NOT LIKE '%CLOB%'
  )
  OR
  (
    name = 'changed_at'
    AND type <> ''
    AND type NOT LIKE '%INT%'
  );


-- ─── STEP 0b-B — PRIMARY KEY CHECK ─────────────────────────────────────
-- Existing reviews/history tables must have id as PRIMARY KEY.

SELECT
  'H2-missing-pk-on-id' AS hazard,
  'product_reviews' AS tbl,
  'id is not PRIMARY KEY' AS detail
WHERE EXISTS (
  SELECT 1 FROM sqlite_master
  WHERE type = 'table' AND name = 'product_reviews'
)
AND NOT EXISTS (
  SELECT 1 FROM pragma_table_info('product_reviews')
  WHERE name = 'id' AND pk >= 1
)

UNION ALL

SELECT
  'H2-missing-pk-on-id',
  'order_status_history',
  'id is not PRIMARY KEY'
WHERE EXISTS (
  SELECT 1 FROM sqlite_master
  WHERE type = 'table' AND name = 'order_status_history'
)
AND NOT EXISTS (
  SELECT 1 FROM pragma_table_info('order_status_history')
  WHERE name = 'id' AND pk >= 1
);


-- ─── STEP 0b-C — ID COLUMN CHECK ──────────────────────────────────────

SELECT
  'H3-id-column-missing' AS hazard,
  'product_reviews' AS tbl,
  'Existing table has no id column' AS detail
WHERE EXISTS (
  SELECT 1 FROM sqlite_master
  WHERE type = 'table' AND name = 'product_reviews'
)
AND NOT EXISTS (
  SELECT 1 FROM pragma_table_info('product_reviews')
  WHERE name = 'id'
)

UNION ALL

SELECT
  'H3-id-column-missing',
  'order_status_history',
  'Existing table has no id column'
WHERE EXISTS (
  SELECT 1 FROM sqlite_master
  WHERE type = 'table' AND name = 'order_status_history'
)
AND NOT EXISTS (
  SELECT 1 FROM pragma_table_info('order_status_history')
  WHERE name = 'id'
);


-- ─── STEP 0b-D — REQUIRED CORE COLUMNS ─────────────────────────────────
-- Missing required columns = STOP.
-- categories is intentionally NOT required.
-- products.category is the existing category field.

WITH required_core(tbl, col) AS (
  VALUES
    ('products','id'),
    ('products','name'),
    ('products','description'),
    ('products','image_url'),
    ('products','category'),
    ('products','selling_price'),
    ('products','supplier_cost'),
    ('products','variants'),
    ('products','is_available'),
    ('products','created_at'),
    ('products','updated_at'),

    ('orders','id'),
    ('orders','full_name'),
    ('orders','mobile'),
    ('orders','alt_mobile'),
    ('orders','house_flat'),
    ('orders','street_locality'),
    ('orders','landmark'),
    ('orders','city'),
    ('orders','district'),
    ('orders','state'),
    ('orders','pin_code'),
    ('orders','total_amount'),
    ('orders','payment_method'),
    ('orders','status'),
    ('orders','created_at'),

    ('order_items','id'),
    ('order_items','order_id'),
    ('order_items','product_id'),
    ('order_items','product_name'),
    ('order_items','variant'),
    ('order_items','quantity'),
    ('order_items','unit_price'),
    ('order_items','line_total'),

    ('admin_users','id'),
    ('admin_users','email'),
    ('admin_users','password_hash'),
    ('admin_users','created_at'),

    ('admin_sessions','token_hash'),
    ('admin_sessions','admin_id'),
    ('admin_sessions','expires_at'),
    ('admin_sessions','created_at')
),
existing_cols(tbl, name) AS (
  SELECT 'products', name
  FROM pragma_table_info('products')

  UNION ALL

  SELECT 'orders', name
  FROM pragma_table_info('orders')

  UNION ALL

  SELECT 'order_items', name
  FROM pragma_table_info('order_items')

  UNION ALL

  SELECT 'admin_users', name
  FROM pragma_table_info('admin_users')

  UNION ALL

  SELECT 'admin_sessions', name
  FROM pragma_table_info('admin_sessions')
)
SELECT
  '0b-D' AS check_id,
  r.tbl,
  r.col AS missing_col,
  'STOP: required core column missing' AS status
FROM required_core r
WHERE EXISTS (
  SELECT 1 FROM sqlite_master
  WHERE type = 'table' AND name = r.tbl
)
AND NOT EXISTS (
  SELECT 1 FROM existing_cols c
  WHERE c.tbl = r.tbl
    AND c.name = r.col
);


-- ─── STEP 0b-E — REQUIRED CORE TABLES ──────────────────────────────────
-- categories is intentionally excluded.

SELECT
  '0b-E' AS check_id,
  t.tbl AS missing_table,
  'STOP: required core table missing' AS status
FROM (
  SELECT 'products' AS tbl
  UNION ALL SELECT 'orders'
  UNION ALL SELECT 'order_items'
  UNION ALL SELECT 'admin_users'
  UNION ALL SELECT 'admin_sessions'
) t
WHERE NOT EXISTS (
  SELECT 1 FROM sqlite_master
  WHERE type = 'table' AND name = t.tbl
);


-- ─── STEP 0b-F — INFORMATIONAL REVIEWS/HISTORY CHECK ──────────────────
-- Missing columns are informational only.
-- In the currently verified database, both tables are absent.
-- STEP 3b and STEP 4 create them with their complete schema.

WITH required_cols(tbl, col) AS (
  VALUES
    ('product_reviews','id'),
    ('product_reviews','product_id'),
    ('product_reviews','reviewer_name'),
    ('product_reviews','rating'),
    ('product_reviews','review_text'),
    ('product_reviews','review_date'),
    ('product_reviews','is_visible'),
    ('product_reviews','created_at'),
    ('product_reviews','updated_at'),

    ('order_status_history','id'),
    ('order_status_history','order_id'),
    ('order_status_history','status'),
    ('order_status_history','note'),
    ('order_status_history','changed_at')
),
existing_cols(tbl, name) AS (
  SELECT 'product_reviews', name
  FROM pragma_table_info('product_reviews')

  UNION ALL

  SELECT 'order_status_history', name
  FROM pragma_table_info('order_status_history')
)
SELECT
  '0b-F' AS check_id,
  r.tbl,
  r.col AS missing_col,
  'INFO: table/column will be created by migration' AS status
FROM required_cols r
WHERE EXISTS (
  SELECT 1 FROM sqlite_master
  WHERE type = 'table' AND name = r.tbl
)
AND NOT EXISTS (
  SELECT 1 FROM existing_cols c
  WHERE c.tbl = r.tbl
    AND c.name = r.col
);


-- ─── STEP 0b STOP RULE ─────────────────────────────────────────────────
--
-- STOP if any rows appear in:
-- H1, H2, H3, 0b-D, or 0b-E.
--
-- 0b-F is informational only.
-- Do not run STEP 2 until STOP-level checks are clear.


-- ─── STEP 2 — PRODUCTS TABLE ADDITIONS ─────────────────────────────────
-- Run each statement separately.
-- These columns were absent in the verified products schema.

ALTER TABLE products
ADD COLUMN sold_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE products
ADD COLUMN images TEXT NOT NULL DEFAULT '[]';

ALTER TABLE products
ADD COLUMN archived_at INTEGER;


-- ─── STEP 3 — ORDERS TABLE ADDITION ────────────────────────────────────
-- estimated_delivery was absent in the verified orders schema.

ALTER TABLE orders
ADD COLUMN estimated_delivery TEXT;


-- ─── STEP 3b — CREATE PRODUCT REVIEWS ──────────────────────────────────
-- The table was confirmed absent in the current database.
-- Do not run this CREATE if a new table has appeared since diagnostics:
-- stop and inspect its schema first.

CREATE TABLE IF NOT EXISTS product_reviews (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  reviewer_name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review_text TEXT NOT NULL,
  review_date TEXT NOT NULL,
  is_visible INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);


-- ─── STEP 4 — CREATE ORDER STATUS HISTORY ──────────────────────────────
-- The table was confirmed absent in the current database.

CREATE TABLE IF NOT EXISTS order_status_history (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  changed_at INTEGER NOT NULL DEFAULT (unixepoch())
);


-- ─── STEP 5 — INDEXES ──────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_reviews_product
ON product_reviews(product_id, is_visible, review_date DESC);

CREATE INDEX IF NOT EXISTS idx_history_order
ON order_status_history(order_id, changed_at);


-- ─── STEP 6 — SAFE BACKFILL ────────────────────────────────────────────

-- Preserve existing images.
-- Only fill images when currently empty.

UPDATE products
SET images = json_array(image_url)
WHERE image_url IS NOT NULL
  AND image_url <> ''
  AND (images IS NULL OR images = '[]');


-- Add one initial history entry for each existing order
-- that does not yet have a history entry.
-- This adds history rows; it does not change existing orders.

INSERT INTO order_status_history (
  id,
  order_id,
  status,
  note,
  changed_at
)
SELECT
  lower(hex(randomblob(16))),
  o.id,
  o.status,
  'Migrated from existing order record',
  o.created_at
FROM orders o
WHERE NOT EXISTS (
  SELECT 1
  FROM order_status_history h
  WHERE h.order_id = o.id
);


-- ─── STEP 7 — VERIFICATION ─────────────────────────────────────────────
-- Compare these counts with STEP 1 BEFORE counts.

SELECT COUNT(*) AS products_after FROM products;

SELECT COUNT(*) AS orders_after FROM orders;

SELECT COUNT(*) AS order_items_after FROM order_items;

SELECT COUNT(*) AS admin_users_after FROM admin_users;

SELECT COUNT(*) AS admin_sessions_after FROM admin_sessions;

PRAGMA table_info(products);
PRAGMA table_info(orders);
PRAGMA table_info(order_items);
PRAGMA table_info(admin_users);
PRAGMA table_info(admin_sessions);
PRAGMA table_info(product_reviews);
PRAGMA table_info(order_status_history);

SELECT COUNT(*) AS history_rows
FROM order_status_history;

SELECT COUNT(*) AS review_rows
FROM product_reviews;


-- ─── FINAL STOP CONDITIONS ─────────────────────────────────────────────
--
-- DO NOT DEPLOY worker.js unless all checks pass.
--
-- STOP if:
-- 1. H1, H2, H3, 0b-D, or 0b-E returned any rows.
-- 2. Products, orders, or order_items counts decreased.
-- 3. Admin users or admin sessions counts unexpectedly decreased.
-- 4. Any required column is missing after migration.
-- 5. Any ALTER failed unexpectedly.
-- 6. Any CREATE or INDEX statement failed unexpectedly.
-- 7. Any unexpected SQL error occurs.
--
-- 0b-F rows are informational only.
--
-- No existing products, orders, order_items, or admin records
-- are intentionally deleted or replaced by this migration.
--
-- STEP 6 adds initial history entries for existing orders
-- that do not already have a history entry.
--
-- categories is not created or required by this migration.
-- Existing products.category remains the category field.
--
-- Keep the Time Travel Bookmark ID saved.
-- If anything unexpected happens, STOP and request review.
-- ═══════════════════════════════════════════════════════════════════════
