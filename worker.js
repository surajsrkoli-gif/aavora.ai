/**
 * AAVORA.ART — Complete backend.
 * See README for routes. All money values are integer paise.
 */

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path === '/api/products' && method === 'GET') return await listPublicProducts(env, cors);
      if (path.startsWith('/api/products/') && method === 'GET') return await getPublicProduct(env, path.split('/')[3], cors);
      if (path === '/api/orders' && method === 'POST') return await createOrder(request, env, cors);
      if (path === '/api/admin/bootstrap' && method === 'POST') return await bootstrapAdmin(request, env, cors);
      if (path === '/api/admin/login' && method === 'POST') return await adminLogin(request, env, cors);
      if (path === '/api/admin/logout' && method === 'POST') return await adminLogout(request, env, cors);

      if (path === '/api/admin/products' && method === 'GET') return await adminListProducts(request, env, cors);
      if (path === '/api/admin/products' && method === 'POST') return await adminCreateProduct(request, env, cors);
      if (path.startsWith('/api/admin/products/') && method === 'PUT') return await adminUpdateProduct(request, env, path.split('/')[4], cors);
      if (path.startsWith('/api/admin/products/') && method === 'DELETE') return await adminDeleteProduct(request, env, path.split('/')[4], cors);
      if (path.startsWith('/api/admin/products/') && path.endsWith('/availability') && method === 'PATCH') return await adminToggleAvailability(request, env, path.split('/')[4], cors);

      if (path === '/api/admin/orders' && method === 'GET') return await adminListOrders(request, env, cors);
      if (path.startsWith('/api/admin/orders/') && path.endsWith('/status') && method === 'PATCH') return await adminUpdateOrderStatus(request, env, path.split('/')[4], cors);

      return json({ error: 'Not found' }, 404, cors);
    } catch (err) {
      return json({ error: 'Server error' }, 500, cors);
    }
  },
};

/* ═══════════════ CORS — strict allowlist, no wildcard ═══════════════ */
function corsHeaders(request, env) {
  const allowed = [env.ALLOWED_ORIGIN, env.ALLOWED_ORIGIN_2]
    .filter(Boolean)
    .map((o) => o.trim().replace(/\/$/, ''));
  const origin = request.headers.get('Origin') || '';
  if (!allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', ...headers },
  });
}
function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  header.split(';').forEach((p) => {
    const [k, ...r] = p.trim().split('=');
    if (k) out[k] = r.join('=');
  });
  return out;
}

/* ═══════════════ Schema detection (cached per isolate) ═══════════════ */
let _schemaCache = null;
async function getSchema(env) {
  if (_schemaCache !== null) return _schemaCache;
  try {
    const info = await env.DB.prepare("SELECT name FROM pragma_table_info('products')").all();
    const cols = new Set(info.results.map((r) => r.name));
    _schemaCache = { hasCategoryId: cols.has('category_id') };
  } catch {
    _schemaCache = { hasCategoryId: false };
  }
  return _schemaCache;
}
function slugify(s) {
  return String(s || 'general').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'general';
}
async function ensureCategoryId(env, categoryName) {
  const name = (categoryName || 'General').trim() || 'General';
  const existing = await env.DB.prepare('SELECT id FROM categories WHERE name = ? LIMIT 1').bind(name).first();
  if (existing?.id) return existing.id;
  const newId = crypto.randomUUID();
  try {
    await env.DB.prepare('INSERT INTO categories (id, name, slug) VALUES (?,?,?)').bind(newId, name, slugify(name)).run();
    return newId;
  } catch {
    const fallback = await env.DB.prepare('SELECT id FROM categories WHERE name = ? OR slug = ? LIMIT 1')
      .bind(name, slugify(name)).first();
    return fallback?.id || null;
  }
}

/* ═══════════════ Public products ═══════════════ */
async function listPublicProducts(env, cors) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, description, image_url, category, selling_price, variants
     FROM products WHERE is_available = 1 ORDER BY created_at DESC`,
  ).all();
  return json(results, 200, cors);
}
async function getPublicProduct(env, id, cors) {
  const p = await env.DB.prepare(
    `SELECT id, name, description, image_url, category, selling_price, variants
     FROM products WHERE id = ? AND is_available = 1`,
  ).bind(id).first();
  if (!p) return json({ error: 'Product not found' }, 404, cors);
  return json(p, 200, cors);
}

/* ═══════════════ Order creation — server validates prices ═══════════════ */
async function createOrder(request, env, cors) {
  const limited = await env.ORDER_RATE_LIMITER.limit({ key: clientIp(request) });
  if (!limited.success) return json({ error: 'Too many requests. Please wait a minute.' }, 429, cors);

  const body = await request.json().catch(() => null);
  const err = validateOrderFields(body);
  if (err) return json({ error: err }, 400, cors);

  const uniqueIds = [...new Set(body.items.map((i) => i.product_id))];
  const placeholders = uniqueIds.map(() => '?').join(',');
  const { results: productRows } = await env.DB.prepare(
    `SELECT id, name, selling_price, variants FROM products
     WHERE id IN (${placeholders}) AND is_available = 1`,
  ).bind(...uniqueIds).all();

  if (productRows.length !== uniqueIds.length) {
    return json({ error: 'One or more products are unavailable' }, 400, cors);
  }

  const map = new Map(productRows.map((p) => [p.id, p]));
  let computedTotal = 0;
  const lineItems = [];
  for (const item of body.items) {
    const p = map.get(item.product_id);
    let allowed = [];
    try { allowed = JSON.parse(p.variants || '[]'); } catch { allowed = []; }
    if (!allowed.length) allowed = ['Default'];
    if (!allowed.includes(item.variant)) {
      return json({ error: `Invalid variant "${item.variant}" for "${p.name}"` }, 400, cors);
    }
    const lineTotal = p.selling_price * item.quantity;
    computedTotal += lineTotal;
    lineItems.push({
      product_id: p.id, product_name: p.name, variant: item.variant,
      quantity: item.quantity, unit_price: p.selling_price, line_total: lineTotal,
    });
  }
  if (body.total_amount !== computedTotal) {
    return json({ error: 'Price mismatch. Please refresh and try again.' }, 400, cors);
  }

  const orderId = `AAV-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
  const now = Math.floor(Date.now() / 1000);

  const statements = [
    env.DB.prepare(
      `INSERT INTO orders (id, full_name, mobile, alt_mobile, house_flat, street_locality,
        landmark, city, district, state, pin_code, total_amount, payment_method, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'COD', 'Pending', ?)`,
    ).bind(
      orderId, body.full_name, body.mobile, body.alt_mobile || null,
      body.house_flat, body.street_locality, body.landmark || null,
      body.city, body.district, body.state, body.pin_code, computedTotal, now,
    ),
    ...lineItems.map((item) =>
      env.DB.prepare(
        `INSERT INTO order_items (id, order_id, product_id, product_name, variant,
           quantity, unit_price, line_total) VALUES (?,?,?,?,?,?,?,?)`,
      ).bind(
        crypto.randomUUID(), orderId, item.product_id, item.product_name,
        item.variant, item.quantity, item.unit_price, item.line_total,
      ),
    ),
  ];
  try {
    await env.DB.batch(statements);
  } catch {
    return json({ error: 'Could not save order. Please retry.' }, 500, cors);
  }
  return json({ order_id: orderId, total_amount: computedTotal }, 201, cors);
}

function validateOrderFields(b) {
  if (!b || typeof b !== 'object') return 'Invalid body';
  const required = ['full_name', 'mobile', 'house_flat', 'street_locality', 'city', 'district', 'state', 'pin_code'];
  for (const f of required) {
    if (typeof b[f] !== 'string' || !b[f].trim()) return `Missing field: ${f}`;
  }
  if (b.full_name.length > 100) return 'Full name too long';
  if (!/^[6-9]\d{9}$/.test(b.mobile)) return 'Invalid mobile number';
  if (b.alt_mobile && !/^[6-9]\d{9}$/.test(b.alt_mobile)) return 'Invalid alternate mobile';
  if (!/^\d{6}$/.test(b.pin_code)) return 'Invalid PIN code';
  if (b.house_flat.length > 120) return 'House/flat too long';
  if (b.street_locality.length > 200) return 'Street/locality too long';
  if (b.city.length > 80) return 'City too long';
  if (b.district.length > 80) return 'District too long';
  if (b.state.length > 80) return 'State too long';
  if (!Array.isArray(b.items) || b.items.length === 0) return 'Cart is empty';
  if (b.items.length > 50) return 'Too many items';
  for (const it of b.items) {
    if (!it.product_id || !it.product_name) return 'Invalid cart item';
    if (!Number.isInteger(it.quantity) || it.quantity < 1 || it.quantity > 20) return `Invalid quantity for ${it.product_name}`;
  }
  if (!Number.isInteger(b.total_amount) || b.total_amount < 1) return 'Invalid total';
  return null;
}
function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

/* ═══════════════ Admin bootstrap (one-time) ═══════════════ */
async function bootstrapAdmin(request, env, cors) {
  const limited = await env.BOOTSTRAP_RATE_LIMITER.limit({ key: clientIp(request) });
  if (!limited.success) return json({ error: 'Too many requests' }, 429, cors);

  const body = await request.json().catch(() => null);
  if (!body || !body.bootstrap_secret || !body.email || !body.password) {
    return json({ error: 'bootstrap_secret, email, and password are required' }, 400, cors);
  }
  if (body.password.length < 10) return json({ error: 'Password must be at least 10 characters' }, 400, cors);
  if (!timingSafeEqual(body.bootstrap_secret, env.BOOTSTRAP_SECRET || '')) {
    return json({ error: 'Forbidden' }, 403, cors);
  }
  const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_users').first();
  if ((existing?.n ?? 0) > 0) return json({ error: 'Admin already exists. Use /api/admin/login.' }, 409, cors);

  const hash = await hashPassword(body.password, env.ADMIN_PEPPER);
  await env.DB.prepare('INSERT INTO admin_users (id, email, password_hash) VALUES (?,?,?)')
    .bind(crypto.randomUUID(), body.email.trim().toLowerCase(), hash).run();
  return json({ ok: true, message: 'Admin created. Delete BOOTSTRAP_SECRET from Worker settings now.' }, 201, cors);
}
function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* ═══════════════ Admin auth ═══════════════ */
async function adminLogin(request, env, cors) {
  const limited = await env.LOGIN_RATE_LIMITER.limit({ key: clientIp(request) });
  if (!limited.success) return json({ error: 'Too many login attempts. Wait a minute.' }, 429, cors);

  const body = await request.json().catch(() => null);
  if (!body || !body.email || !body.password) return json({ error: 'Email and password required' }, 400, cors);

  const user = await env.DB.prepare('SELECT id, password_hash FROM admin_users WHERE email = ?')
    .bind(body.email.trim().toLowerCase()).first();
  if (!user) return json({ error: 'Invalid credentials' }, 401, cors);
  const ok = await verifyPassword(body.password, user.password_hash, env.ADMIN_PEPPER);
  if (!ok) return json({ error: 'Invalid credentials' }, 401, cors);

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = Date.now() + 1000 * 60 * 60 * 8;
  await env.DB.prepare('INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES (?,?,?)')
    .bind(tokenHash, user.id, expiresAt).run();

  // Host-only cookie. SameSite=Lax works because aavora.art and api.aavora.art
  // share the same registrable domain.
  const cookie = [
    `aavora_admin=${token}`, 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', `Max-Age=${60 * 60 * 8}`,
  ].join('; ');
  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie, ...cors },
  });
}
async function adminLogout(request, env, cors) {
  const token = parseCookies(request)['aavora_admin'];
  if (token) {
    const hash = await sha256Hex(token);
    await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(hash).run();
  }
  const cookie = 'aavora_admin=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie, ...cors },
  });
}
async function requireAdmin(request, env) {
  const token = parseCookies(request)['aavora_admin'];
  if (!token) return null;
  const hash = await sha256Hex(token);
  const session = await env.DB.prepare('SELECT admin_id, expires_at FROM admin_sessions WHERE token_hash = ?')
    .bind(hash).first();
  if (!session || session.expires_at < Date.now()) return null;
  return session.admin_id;
}

async function hashPassword(password, pepper) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const peppered = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(password));
  const baseKey = await crypto.subtle.importKey('raw', peppered, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, baseKey, 256);
  return `${btoa(String.fromCharCode(...salt))}:${btoa(String.fromCharCode(...new Uint8Array(bits)))}`;
}
async function verifyPassword(password, stored, pepper) {
  const [saltB64, hashB64] = stored.split(':');
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const peppered = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(password));
  const baseKey = await crypto.subtle.importKey('raw', peppered, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, baseKey, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits))) === hashB64;
}
async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randomToken(bytes = 32) {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))));
}

/* ═══════════════ Image URL validation ═══════════════ */
function validateImageUrl(url) {
  if (!url) return null;
  if (typeof url !== 'string') return 'Image URL must be a string';
  if (url.length > 500) return 'Image URL too long (max 500 characters)';
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') {
      return 'Image URL must start with https:// — data:, javascript:, and file: are not permitted';
    }
  } catch {
    return 'Invalid image URL';
  }
  return null;
}

/* ═══════════════ Admin products ═══════════════ */
async function adminListProducts(request, env, cors) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
  const { results } = await env.DB.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
  // Compute profit on the server (paise) so the UI only formats.
  const withProfit = results.map((p) => {
    const profit = (p.selling_price || 0) - (p.supplier_cost || 0);
    const margin = p.selling_price > 0 ? (profit / p.selling_price) * 100 : 0;
    return { ...p, estimated_profit: profit, profit_margin_pct: Number(margin.toFixed(2)) };
  });
  return json(withProfit, 200, cors);
}

async function adminCreateProduct(request, env, cors) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
  const b = await request.json().catch(() => null);
  const err = validateProduct(b);
  if (err) return json({ error: err }, 400, cors);

  const schema = await getSchema(env);
  const categoryName = (b.category || 'General').trim() || 'General';
  let categoryIdValue = null;
  if (schema.hasCategoryId) {
    categoryIdValue = await ensureCategoryId(env, categoryName);
    if (!categoryIdValue) return json({ error: 'Could not resolve category' }, 500, cors);
  }

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const variantsJson = JSON.stringify(b.variants || []);

  if (schema.hasCategoryId) {
    await env.DB.prepare(
      `INSERT INTO products (id, name, description, image_url, category, category_id,
        selling_price, supplier_cost, variants, is_available, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id, b.name, b.description || '', b.image_url || '', categoryName, categoryIdValue,
      b.selling_price, b.supplier_cost || 0, variantsJson, b.is_available ? 1 : 0, now, now,
    ).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO products (id, name, description, image_url, category,
        selling_price, supplier_cost, variants, is_available, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id, b.name, b.description || '', b.image_url || '', categoryName,
      b.selling_price, b.supplier_cost || 0, variantsJson, b.is_available ? 1 : 0, now, now,
    ).run();
  }
  return json({ id }, 201, cors);
}

async function adminUpdateProduct(request, env, id, cors) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
  const b = await request.json().catch(() => null);
  const err = validateProduct(b);
  if (err) return json({ error: err }, 400, cors);

  const schema = await getSchema(env);
  const categoryName = (b.category || 'General').trim() || 'General';
  let categoryIdValue = null;
  if (schema.hasCategoryId) {
    categoryIdValue = await ensureCategoryId(env, categoryName);
    if (!categoryIdValue) return json({ error: 'Could not resolve category' }, 500, cors);
  }

  let result;
  if (schema.hasCategoryId) {
    result = await env.DB.prepare(
      `UPDATE products SET name=?, description=?, image_url=?, category=?, category_id=?,
        selling_price=?, supplier_cost=?, variants=?, is_available=?, updated_at=?
       WHERE id=?`,
    ).bind(
      b.name, b.description || '', b.image_url || '', categoryName, categoryIdValue,
      b.selling_price, b.supplier_cost || 0, JSON.stringify(b.variants || []),
      b.is_available ? 1 : 0, Math.floor(Date.now() / 1000), id,
    ).run();
  } else {
    result = await env.DB.prepare(
      `UPDATE products SET name=?, description=?, image_url=?, category=?,
        selling_price=?, supplier_cost=?, variants=?, is_available=?, updated_at=?
       WHERE id=?`,
    ).bind(
      b.name, b.description || '', b.image_url || '', categoryName,
      b.selling_price, b.supplier_cost || 0, JSON.stringify(b.variants || []),
      b.is_available ? 1 : 0, Math.floor(Date.now() / 1000), id,
    ).run();
  }
  if (result.meta.changes === 0) return json({ error: 'Product not found' }, 404, cors);
  return json({ ok: true }, 200, cors);
}

async function adminDeleteProduct(request, env, id, cors) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
  const result = await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
  if (result.meta.changes === 0) return json({ error: 'Product not found' }, 404, cors);
  return json({ ok: true }, 200, cors);
}

async function adminToggleAvailability(request, env, id, cors) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
  const b = await request.json().catch(() => null);
  if (!b || typeof b.is_available !== 'boolean') return json({ error: 'is_available must be boolean' }, 400, cors);
  const result = await env.DB.prepare('UPDATE products SET is_available = ?, updated_at = ? WHERE id = ?')
    .bind(b.is_available ? 1 : 0, Math.floor(Date.now() / 1000), id).run();
  if (result.meta.changes === 0) return json({ error: 'Product not found' }, 404, cors);
  return json({ ok: true }, 200, cors);
}

function validateProduct(b) {
  if (!b || typeof b !== 'object') return 'Invalid body';
  if (!b.name || typeof b.name !== 'string' || !b.name.trim()) return 'Name required';
  if (b.name.length > 200) return 'Name too long';
  if (!Number.isInteger(b.selling_price) || b.selling_price < 1) return 'Selling price must be at least ₹1 (100 paise)';
  if (b.supplier_cost != null) {
    if (!Number.isInteger(b.supplier_cost) || b.supplier_cost < 0) return 'Supplier cost must be a non-negative integer (paise)';
    if (b.supplier_cost > b.selling_price) return 'Supplier cost cannot exceed selling price';
  }
  if (b.variants != null) {
    if (!Array.isArray(b.variants)) return 'Variants must be an array';
    if (b.variants.length > 30) return 'Too many variants';
    for (const v of b.variants) {
      if (typeof v !== 'string' || !v.trim() || v.length > 100) return 'Each variant must be a non-empty string (max 100 chars)';
    }
  }
  if (b.description != null && typeof b.description !== 'string') return 'Invalid description';
  if (b.description && b.description.length > 2000) return 'Description too long';
  const urlErr = validateImageUrl(b.image_url);
  if (urlErr) return urlErr;
  if (b.category != null && typeof b.category !== 'string') return 'Invalid category';
  if (b.category && b.category.length > 80) return 'Category too long';
  return null;
}

/* ═══════════════ Admin orders ═══════════════ */
async function adminListOrders(request, env, cors) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
  const { results: orders } = await env.DB.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200').all();
  const { results: items } = await env.DB.prepare('SELECT * FROM order_items ORDER BY rowid ASC').all();
  const byOrder = {};
  for (const it of items) {
    if (!byOrder[it.order_id]) byOrder[it.order_id] = [];
    byOrder[it.order_id].push(it);
  }
  return json(orders.map((o) => ({ ...o, items: byOrder[o.id] || [] })), 200, cors);
}
async function adminUpdateOrderStatus(request, env, id, cors) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401, cors);
  const b = await request.json().catch(() => null);
  const allowed = ['Pending', 'Contacted', 'Confirmed', 'Supplier Ordered', 'Shipped', 'Delivered', 'Cancelled', 'Returned'];
  if (!b || !allowed.includes(b.status)) return json({ error: 'Invalid status' }, 400, cors);
  const result = await env.DB.prepare('UPDATE orders SET status = ? WHERE id = ?').bind(b.status, id).run();
  if (result.meta.changes === 0) return json({ error: 'Order not found' }, 404, cors);
  return json({ ok: true }, 200, cors);
}
