
-- ═══════════════════════════════════════════════════════════════════════
-- AAVORA.ART — SAFE ADDITIVE MIGRATION
--
-- IMPORTANT:
-- 1. Run every SQL statement ONE AT A TIME in Cloudflare D1 Console.
-- 2. Run STEP 1 and STEP 0b first. Do not run STEP 2 onward until cleared.
-- 3. Never skip an error unless it is a verified duplicate-column or
--    already-exists condition.
-- 4. No DROP TABLE, DROP COLUMN, or DELETE of existing data.
-- 5. Take a restorable backup before making any production changes.
-- ═══════════════════════════════════════════════════════════════════════


-- ─── STEP 1 — DIAGNOSTICS (READ ONLY) ─────────────────────────────────

SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;

PRAGMA table_info(products);
PRAGMA table_info(orders);
PRAGMA table_info(order_items);
PRAGMA table_info(categories);
PRAGMA table_info(admin_users);
PRAGMA table_info(admin_sessions);
PRAGMA table_info(product_reviews);
PRAGMA table_info(order_status_history);

SELECT 'products' AS tbl, COUNT(*) AS n FROM products
UNION ALL SELECT 'orders', COUNT(*) FROM orders
UNION ALL SELECT 'order_items', COUNT(*) FROM order_items
UNION ALL SELECT 'categories', COUNT(*) FROM categories;

-- Save these results as BEFORE counts.


-- ─── STEP 0b — HAZARD DETECTION (READ ONLY) ────────────────────────────
-- Run every SELECT below separately.
-- Any STOP-level result means STOP. Do not run STEP 2 onward.


-- 0b-A — Incompatible existing column types

SELECT 'H1-incompatible-type' AS hazard,
       'product_reviews' AS tbl, name, type AS actual
FROM pragma_table_info('product_reviews')
WHERE
  (name IN ('id','product_id','reviewer_name','review_text','review_date')
   AND type <> ''
   AND type NOT LIKE '%CHAR%'
   AND type NOT LIKE '%TEXT%'
   AND type NOT LIKE '%CLOB%')
  OR
  (name IN ('rating','is_visible','created_at','updated_at')
   AND type <> '' AND type NOT LIKE '%INT%')

UNION ALL

SELECT 'H1-incompatible-type',
       'order_status_history', name, type
FROM pragma_table_info('order_status_history')
WHERE
  (name IN ('id','order_id','status','note')
   AND type <> ''
   AND type NOT LIKE '%CHAR%'
   AND type NOT LIKE '%TEXT%'
   AND type NOT LIKE '%CLOB%')
  OR
  (name = 'changed_at' AND type <> '' AND type NOT LIKE '%INT%');


-- 0b-B — Existing reviews/history tables must have id as PRIMARY KEY

SELECT 'H2-missing-pk-on-id' AS hazard,
       'product_reviews' AS tbl,
       'table exists but id is not PRIMARY KEY' AS detail
WHERE EXISTS (
  SELECT 1 FROM sqlite_master
  WHERE type='table' AND name='product_reviews'
)
AND NOT EXISTS (
  SELECT 1 FROM pragma_table_info('product_reviews')
  WHERE name='id' AND pk >= 1
)

UNION ALL

SELECT 'H2-missing-pk-on-id',
       'order_status_history',
       'table exists but id is not PRIMARY KEY'
WHERE EXISTS (
  SELECT 1 FROM sqlite_master
  WHERE type='table' AND name='order_status_history'
)
AND NOT EXISTS (
  SELECT 1 FROM pragma_table_info('order_status_history')
  WHERE name='id' AND pk >= 1
);


-- 0b-C — Existing reviews/history tables must have an id column

SELECT 'H3-id-column-missing' AS hazard,
       'product_reviews' AS tbl,
       'table exists but has no id column; ALTER cannot add a PK column' AS detail
WHERE EXISTS (
  SELECT 1 FROM sqlite_master
  WHERE type='table' AND name='product_reviews'
)
AND NOT EXISTS (
  SELECT 1 FROM pragma_table_info('product_reviews')
  WHERE name='id'
)

UNION ALL

SELECT 'H3-id-column-missing',
       'order_status_history',
       'table exists but has no id column; ALTER cannot add a PK column'
WHERE EXISTS (
  SELECT 1 FROM sqlite_master
  WHERE type='table' AND name='order_status_history'
)
AND NOT EXISTS (
  SELECT 1 FROM pragma_table_info('order_status_history')
  WHERE name='id'
);


-- 0b-D — Missing required CORE columns (STOP)
-- These columns are NOT added by this migration.

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

    ('categories','id'),
    ('categories','name'),
    ('categories','slug'),

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
  SELECT 'products', name FROM pragma_table_info('products')
  UNION ALL SELECT 'orders', name FROM pragma_table_info('orders')
  UNION ALL SELECT 'order_items', name FROM pragma_table_info('order_items')
  UNION ALL SELECT 'categories', name FROM pragma_table_info('categories')
  UNION ALL SELECT 'admin_users', name FROM pragma_table_info('admin_users')
  UNION ALL SELECT 'admin_sessions', name FROM pragma_table_info('admin_sessions')
)
SELECT
  '0b-D' AS check_id,
  r.tbl,
  r.col AS missing_col,
  'STOP: required core column missing; migration does NOT add it' AS status
FROM required_core r
WHERE EXISTS (
  SELECT 1 FROM sqlite_master
  WHERE type='table' AND name=r.tbl
)
AND NOT EXISTS (
  SELECT 1 FROM existing_cols c
  WHERE c.tbl=r.tbl AND c.name=r.col
);


-- 0b-E — Missing required CORE tables (STOP)

SELECT '0b-E' AS check_id,
       t.tbl AS missing_table,
       'STOP: required core table missing; migration does NOT create it' AS status
FROM (
  SELECT 'products' AS tbl
  UNION ALL SELECT 'orders'
  UNION ALL SELECT 'order_items'
  UNION ALL SELECT 'categories'
  UNION ALL SELECT 'admin_users'
  UNION ALL SELECT 'admin_sessions'
) t
WHERE NOT EXISTS (
  SELECT 1 FROM sqlite_master
  WHERE type='table' AND name=t.tbl
);


-- 0b-F — Informational missing columns in reviews/history
-- These columns are added by STEP 3b and STEP 4.
-- Results here alone do NOT stop migration.

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
  'INFO: migration adds this column' AS status
FROM required_cols r
WHERE EXISTS (
  SELECT 1 FROM sqlite_master
  WHERE type='table' AND name=r.tbl
)
AND NOT EXISTS (
  SELECT 1 FROM existing_cols c
  WHERE c.tbl=r.tbl AND c.name=r.col
);


-- ─── STEP 0b STOP RULE ─────────────────────────────────────────────────
-- STOP if any rows appear in:
-- H1, H2, H3, 0b-D, or 0b-E.
-- 0b-F is informational only.
-- Do not run STEP 2 until the STOP-level checks are clear.


-- ─── STEP 2 — PRODUCTS TABLE ALTERS ────────────────────────────────────
-- Run each ALTER separately.

ALTER TABLE products ADD COLUMN sold_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE products ADD COLUMN images TEXT NOT NULL DEFAULT '[]';

ALTER TABLE products ADD COLUMN archived_at INTEGER;


-- ─── STEP 3 — ORDERS TABLE ─────────────────────────────────────────────

ALTER TABLE orders ADD COLUMN estimated_delivery TEXT;


-- ─── STEP 3b — PRODUCT REVIEWS ─────────────────────────────────────────
-- Run CREATE first, then each ALTER separately.
-- If a column already exists, verify with PRAGMA before skipping its ALTER.

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

ALTER TABLE product_reviews ADD COLUMN product_id TEXT NOT NULL DEFAULT '';

ALTER TABLE product_reviews ADD COLUMN reviewer_name TEXT NOT NULL DEFAULT '';

ALTER TABLE product_reviews ADD COLUMN rating INTEGER NOT NULL DEFAULT 5;

ALTER TABLE product_reviews ADD COLUMN review_text TEXT NOT NULL DEFAULT '';

ALTER TABLE product_reviews ADD COLUMN review_date TEXT NOT NULL DEFAULT '1970-01-01';

ALTER TABLE product_reviews ADD COLUMN is_visible INTEGER NOT NULL DEFAULT 1;

ALTER TABLE product_reviews ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE product_reviews ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;


-- Backfill only invalid timestamps; preserve existing non-zero values.

UPDATE product_reviews
SET created_at = COALESCE(
  CASE
    WHEN review_date IS NOT NULL
      AND review_date <> ''
      AND review_date <> '1970-01-01'
    THEN CAST(strftime('%s', review_date) AS INTEGER)
    ELSE NULL
  END,
  unixepoch()
)
WHERE created_at IS NULL OR created_at = 0;

UPDATE product_reviews
SET updated_at = created_at
WHERE (updated_at IS NULL OR updated_at = 0)
  AND created_at > 0;


-- ─── STEP 4 — ORDER STATUS HISTORY ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS order_status_history (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  changed_at INTEGER NOT NULL DEFAULT (unixepoch())
);

ALTER TABLE order_status_history ADD COLUMN order_id TEXT NOT NULL DEFAULT '';

ALTER TABLE order_status_history ADD COLUMN status TEXT NOT NULL DEFAULT 'Pending';

ALTER TABLE order_status_history ADD COLUMN note TEXT;

ALTER TABLE order_status_history ADD COLUMN changed_at INTEGER NOT NULL DEFAULT 0;


-- Backfill only when a matching order has a valid created_at timestamp.

UPDATE order_status_history
SET changed_at = (
  SELECT NULLIF(created_at, 0)
  FROM orders
  WHERE orders.id = order_status_history.order_id
)
WHERE (changed_at IS NULL OR changed_at = 0)
AND EXISTS (
  SELECT 1 FROM orders
  WHERE orders.id = order_status_history.order_id
    AND orders.created_at > 0
);


-- ─── STEP 5 — INDEXES ──────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_reviews_product
ON product_reviews(product_id, is_visible, review_date DESC);

CREATE INDEX IF NOT EXISTS idx_history_order
ON order_status_history(order_id, changed_at);


-- ─── STEP 6 — BACKFILL ─────────────────────────────────────────────────
-- These statements are designed to be repeatable.

UPDATE products
SET images = json_array(image_url)
WHERE image_url IS NOT NULL
  AND image_url <> ''
  AND (images IS NULL OR images = '[]');

INSERT INTO order_status_history (id, order_id, status, note, changed_at)
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

SELECT 'products' AS tbl, COUNT(*) AS n FROM products
UNION ALL SELECT 'orders', COUNT(*) FROM orders
UNION ALL SELECT 'order_items', COUNT(*) FROM order_items
UNION ALL SELECT 'categories', COUNT(*) FROM categories;

PRAGMA table_info(products);
PRAGMA table_info(orders);
PRAGMA table_info(order_items);
PRAGMA table_info(categories);
PRAGMA table_info(admin_users);
PRAGMA table_info(admin_sessions);
PRAGMA table_info(product_reviews);
PRAGMA table_info(order_status_history);

SELECT COUNT(*) AS history_rows FROM order_status_history;

SELECT COUNT(*) AS review_rows FROM product_reviews;


-- ─── FINAL STOP CONDITIONS ────────────────────────────────────────────
--
-- DO NOT DEPLOY worker.js unless all checks pass.
--
-- STOP if:
-- 1. H1, H2, H3, 0b-D, or 0b-E returned any rows.
-- 2. STEP 1 vs STEP 7 counts decreased for products, orders,
--    order_items, or categories.
-- 3. Any required column is missing after migration.
-- 4. Any ALTER failed except a verified duplicate-column condition.
-- 5. Any CREATE failed except a verified already-exists condition.
-- 6. Any unexpected SQL error occurs.
--
-- 0b-F rows are informational only.
--
-- The migration does not DROP tables or delete existing records.
-- STEP 6 adds history rows for old orders that have no history entry.
-- This is an additive data change.
--
-- Take a verified restorable backup before running migration.
-- If anything unexpected happens, STOP and request review.
-- ═══════════════════════════════════════════════════════════════════════
