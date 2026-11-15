/**
 * AAVORA.ART — Worker.
 * Worker name (wrangler.toml): aavora-ai-backend
 *
 * Routes unchanged in shape from the previous version; internals audited.
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
    const origin = request.headers.get('Origin');
    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    const isAdminRoute = path.startsWith('/api/admin/');

    // CSRF / Origin enforcement
    if (isMutation) {
      if (origin === 'null' || origin === 'undefined') {
        return json({ error: 'Forbidden origin' }, 403, {});
      }
      if (isAdminRoute && !origin) {
        return json({ error: 'Origin header required for admin requests' }, 403, {});
      }
      if (origin && !allowedOrigins(env).includes(origin)) {
        return json({ error: 'Forbidden origin' }, 403, {});
      }
    }

    try {
      if (path.startsWith('/images/') && method === 'GET')
        return await serveImage(env, path.slice(8));

      if (path === '/api/products' && method === 'GET')
        return await listPublicProducts(env, cors);

      if (path.startsWith('/api/products/') && method === 'GET')
        return await getPublicProduct(env, path.split('/')[3], cors);

      if (path === '/api/orders' && method === 'POST')
        return await createOrder(request, env, cors);

      if (path === '/api/track-order' && method === 'POST')
        return await trackOrder(request, env, cors);

      if (path === '/api/admin/bootstrap' && method === 'POST')
        return await bootstrapAdmin(request, env, cors);

      if (path === '/api/admin/login' && method === 'POST')
        return await adminLogin(request, env, cors);

      if (path === '/api/admin/logout' && method === 'POST')
        return await adminLogout(request, env, cors);

      if (path === '/api/admin/products' && method === 'GET')
        return await adminListProducts(request, env, cors);

      if (path === '/api/admin/products' && method === 'POST')
        return await adminCreateProduct(request, env, cors);

      if (path.startsWith('/api/admin/products/') && method === 'PUT')
        return await adminUpdateProduct(request, env, path.split('/')[4], cors);

      if (path.startsWith('/api/admin/products/') &&
          method === 'DELETE' && !path.endsWith('/images'))
        return await adminDeleteProduct(request, env, path.split('/')[4], cors);

      if (path.startsWith('/api/admin/products/') &&
          path.endsWith('/availability') && method === 'PATCH')
        return await adminToggleAvailability(request, env, path.split('/')[4], cors);

      if (path.startsWith('/api/admin/products/') &&
          path.endsWith('/images') && method === 'POST')
        return await adminUploadImage(request, env, path.split('/')[4], cors);

      if (path.startsWith('/api/admin/products/') &&
          path.endsWith('/images') && method === 'DELETE')
        return await adminDeleteOrphanImage(request, env, path.split('/')[4], cors);

      if (path === '/api/admin/orders' && method === 'GET')
        return await adminListOrders(request, env, cors);

      if (path.startsWith('/api/admin/orders/') && method === 'GET')
        return await adminGetOrder(request, env, path.split('/')[4], cors);

      if (path.startsWith('/api/admin/orders/') &&
          path.endsWith('/status') && method === 'PATCH')
        return await adminUpdateOrderStatus(request, env, path.split('/')[4], cors);

      if (path === '/api/admin/reviews' && method === 'GET')
        return await adminListReviews(request, env, cors);

      if (path === '/api/admin/reviews' && method === 'POST')
        return await adminCreateReview(request, env, cors);

      if (path.startsWith('/api/admin/reviews/') && method === 'PUT')
        return await adminUpdateReview(request, env, path.split('/')[4], cors);

      if (path.startsWith('/api/admin/reviews/') && method === 'DELETE')
        return await adminDeleteReview(request, env, path.split('/')[4], cors);

      return json({ error: 'Not found' }, 404, cors);
    } catch {
      return json({ error: 'Server error' }, 500, cors);
    }
  },
};

/* Helpers */

function allowedOrigins(env) {
  return [env.ALLOWED_ORIGIN, env.ALLOWED_ORIGIN_2]
    .filter(Boolean)
    .map((o) => o.trim().replace(/\/$/, ''));
}

function corsHeaders(request, env) {
  const allowed = allowedOrigins(env);
  const origin = request.headers.get('Origin') || '';
  if (!allowed.includes(origin)) return {};

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
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

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

function extractImageKey(url) {
  if (typeof url !== 'string') return null;

  const marker = '/images/';
  const i = url.indexOf(marker);
  if (i === -1) return null;

  return url.slice(i + marker.length);
}

async function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const aBytes = typeof a === 'string' ? enc.encode(a) : new Uint8Array(a);
  const bBytes = typeof b === 'string' ? enc.encode(b) : new Uint8Array(b);

  const [aDigest, bDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', aBytes),
    crypto.subtle.digest('SHA-256', bBytes),
  ]);

  const aArr = new Uint8Array(aDigest);
  const bArr = new Uint8Array(bDigest);

  let d = 0;
  for (let i = 0; i < 32; i++) d |= aArr[i] ^ bArr[i];

  return d === 0;
}

/* R2 image serving */

async function serveImage(env, key) {
  if (!env.PRODUCT_IMAGES)
    return new Response('Not found', { status: 404 });

  if (!key || key.includes('..'))
    return new Response('Bad key', { status: 400 });

  const object = await env.PRODUCT_IMAGES.get(key);
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);

  if (!headers.has('Content-Type'))
    headers.set('Content-Type', 'application/octet-stream');

  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Access-Control-Allow-Origin', '*');

  return new Response(object.body, { headers });
}

/* Public products */

async function listPublicProducts(env, cors) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, description, image_url, category,
            selling_price, variants, sold_count, images
     FROM products
     WHERE is_available = 1
     ORDER BY created_at DESC`
  ).all();

  return json(results, 200, cors);
}

async function getPublicProduct(env, id, cors) {
  const p = await env.DB.prepare(
    `SELECT id, name, description, image_url, category,
            selling_price, variants, sold_count, images
     FROM products
     WHERE id = ? AND is_available = 1`
  ).bind(id).first();

  if (!p) return json({ error: 'Product not found' }, 404, cors);

  const { results: reviews } = await env.DB.prepare(
    `SELECT reviewer_name, rating, review_text, review_date
     FROM product_reviews
     WHERE product_id = ? AND is_visible = 1
     ORDER BY review_date DESC`
  ).bind(id).all();

  const avg = reviews.length
    ? Number((
        reviews.reduce((s, r) => s + r.rating, 0) / reviews.length
      ).toFixed(2))
    : 0;

  return json({
    ...p,
    reviews,
    review_count: reviews.length,
    average_rating: avg,
  }, 200, cors);
} 
/* Order creation */

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
  if (productRows.length !== uniqueIds.length)
    return json({ error: 'One or more products are unavailable' }, 400, cors);

  const map = new Map(productRows.map((p) => [p.id, p]));
  let computedTotal = 0;
  const lineItems = [];
  for (const item of body.items) {
    const p = map.get(item.product_id);
    let allowed = [];
    try { allowed = JSON.parse(p.variants || '[]'); } catch {}
    if (!allowed.length) allowed = ['Default'];
    if (!allowed.includes(item.variant))
      return json({ error: 'Invalid variant for one or more products' }, 400, cors);
    const lineTotal = p.selling_price * item.quantity;
    computedTotal += lineTotal;
    lineItems.push({
      product_id: p.id, product_name: p.name, variant: item.variant,
      quantity: item.quantity, unit_price: p.selling_price, line_total: lineTotal,
    });
  }
  if (body.total_amount !== computedTotal)
    return json({ error: 'Price mismatch. Please refresh and try again.' }, 400, cors);

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
    env.DB.prepare(
      `INSERT INTO order_status_history (id, order_id, status, note, changed_at)
       VALUES (?,?, 'Pending', 'Order placed', ?)`,
    ).bind(crypto.randomUUID(), orderId, now),
  ];
  try { await env.DB.batch(statements); }
  catch { return json({ error: 'Could not save order. Please retry.' }, 500, cors); }
  return json({ order_id: orderId, total_amount: computedTotal }, 201, cors);
}

function validateOrderFields(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'Invalid body';
  const required = ['full_name', 'mobile', 'house_flat', 'street_locality', 'city', 'district', 'state', 'pin_code'];
  for (const f of required) {
    if (typeof b[f] !== 'string' || !b[f].trim()) return `Missing or invalid field: ${f}`;
  }
  if (b.full_name.length > 100) return 'Full name too long';
  if (!/^[6-9]\d{9}$/.test(b.mobile)) return 'Invalid mobile number';
  if (b.alt_mobile !== undefined && b.alt_mobile !== null && b.alt_mobile !== '') {
    if (typeof b.alt_mobile !== 'string' || !/^[6-9]\d{9}$/.test(b.alt_mobile))
      return 'Invalid alternate mobile';
  }
  if (!/^\d{6}$/.test(b.pin_code)) return 'Invalid PIN code';
  if (b.house_flat.length > 120) return 'House/flat too long';
  if (b.street_locality.length > 200) return 'Street/locality too long';
  if (b.landmark !== undefined && b.landmark !== null && b.landmark !== '') {
    if (typeof b.landmark !== 'string' || b.landmark.length > 120) return 'Invalid landmark';
  }
  if (b.city.length > 80) return 'City too long';
  if (b.district.length > 80) return 'District too long';
  if (b.state.length > 80) return 'State too long';

  if (!Array.isArray(b.items) || b.items.length === 0) return 'Cart is empty';
  if (b.items.length > 50) return 'Too many items in cart';

  for (const it of b.items) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return 'Invalid cart item';
    if (typeof it.product_id !== 'string' || it.product_id.length < 1 || it.product_id.length > 100)
      return 'Invalid product ID in cart';
    if (typeof it.variant !== 'string' || it.variant.length < 1 || it.variant.length > 100)
      return 'Invalid variant in cart';
    if (!Number.isInteger(it.quantity) || it.quantity < 1 || it.quantity > 20)
      return 'Invalid quantity in cart (must be 1–20)';
  }
  if (!Number.isInteger(b.total_amount) || b.total_amount < 1) return 'Invalid total amount';
  if (b.total_amount > 1_000_000_000) return 'Order total exceeds maximum allowed';
  return null;
}

/* Public tracking */

async function trackOrder(request, env, cors) {
  if (!env.TRACKING_RATE_LIMITER)
    return json({ error: 'Order tracking is temporarily unavailable. Please try again later.' }, 503, cors);
  const limited = await env.TRACKING_RATE_LIMITER.limit({ key: clientIp(request) });
  if (!limited.success) return json({ error: 'Too many requests. Please wait a minute.' }, 429, cors);

  const body = await request.json().catch(() => null);
  if (!body || typeof body.order_id !== 'string' || typeof body.mobile !== 'string')
    return json({ error: 'Order ID and mobile number are required' }, 400, cors);
  const orderId = body.order_id.trim();
  const mobile = body.mobile.trim();
  if (orderId.length < 1 || orderId.length > 100) return json({ error: 'Order not found' }, 404, cors);
  if (!/^[6-9]\d{9}$/.test(mobile)) return json({ error: 'Order not found' }, 404, cors);

  const order = await env.DB.prepare(
    `SELECT id, total_amount, payment_method, status, created_at, estimated_delivery
     FROM orders WHERE id = ? AND mobile = ?`,
  ).bind(orderId, mobile).first();
  if (!order) return json({ error: 'Order not found' }, 404, cors);

  const { results: items } = await env.DB.prepare(
    `SELECT product_name, variant, quantity, line_total FROM order_items WHERE order_id = ?`,
  ).bind(orderId).all();

  const { results: history } = await env.DB.prepare(
    `SELECT status, changed_at FROM order_status_history
     WHERE order_id = ? ORDER BY changed_at ASC`,
  ).bind(orderId).all();

  return json({
    order_id: order.id,
    order_date: order.created_at,
    total_amount: order.total_amount,
    payment_method: order.payment_method,
    current_status: order.status,
    estimated_delivery: order.estimated_delivery || null,
    items,
    history,
  }, 200, cors);
}

/* Admin auth */

async function bootstrapAdmin(request, env, cors) {
  const limited = await env.BOOTSTRAP_RATE_LIMITER.limit({ key: clientIp(request) });
  if (!limited.success) return json({ error: 'Too many requests' }, 429, cors);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'Invalid body' }, 400, cors);
  if (typeof body.bootstrap_secret !== 'string' || typeof body.email !== 'string' || typeof body.password !== 'string')
    return json({ error: 'bootstrap_secret, email, and password are required' }, 400, cors);
  if (body.email.length < 3 || body.email.length > 200) return json({ error: 'Invalid email length' }, 400, cors);
  if (body.password.length < 10) return json({ error: 'Password must be at least 10 characters' }, 400, cors);
  if (body.password.length > 100) return json({ error: 'Password too long' }, 400, cors);
  if (!(await constantTimeEqual(body.bootstrap_secret, env.BOOTSTRAP_SECRET || '')))
    return json({ error: 'Forbidden' }, 403, cors);

  const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_users').first();
  if ((existing?.n ?? 0) > 0) return json({ error: 'Admin already exists. Use /api/admin/login.' }, 409, cors);

  const hash = await hashPassword(body.password, env.ADMIN_PEPPER);
  await env.DB.prepare('INSERT INTO admin_users (id, email, password_hash) VALUES (?,?,?)')
    .bind(crypto.randomUUID(), body.email.trim().toLowerCase(), hash).run();
  return json({ ok: true, message: 'Admin created. Delete BOOTSTRAP_SECRET from Worker settings now.' }, 201, cors);
}

async function adminLogin(request, env, cors) {
  const limited = await env.LOGIN_RATE_LIMITER.limit({ key: clientIp(request) });
  if (!limited.success) return json({ error: 'Too many login attempts. Wait a minute.' }, 429, cors);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'Invalid body' }, 400, cors);
  if (typeof body.email !== 'string' || typeof body.password !== 'string')
    return json({ error: 'Email and password required' }, 400, cors);
  if (body.email.length < 3 || body.email.length > 200) return json({ error: 'Invalid credentials' }, 401, cors);
  if (body.password.length < 1 || body.password.length > 200) return json({ error: 'Invalid credentials' }, 401, cors);

  const user = await env.DB.prepare('SELECT id, password_hash FROM admin_users WHERE email = ?')
    .bind(body.email.trim().toLowerCase()).first();
  if (!user) return json({ error: 'Invalid credentials' }, 401, cors);
  if (!(await verifyPassword(body.password, user.password_hash, env.ADMIN_PEPPER)))
    return json({ error: 'Invalid credentials' }, 401, cors);

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = Date.now() + 1000 * 60 * 60 * 8;
  await env.DB.prepare('INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES (?,?,?)')
    .bind(tokenHash, user.id, expiresAt).run();
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
  const parts = String(stored).split(':');
  if (parts.length !== 2) return false;
  const [saltB64, hashB64] = parts;
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const peppered = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(password));
  const baseKey = await crypto.subtle.importKey('raw', peppered, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, baseKey, 256);
  const computedB64 = btoa(String.fromCharCode(...new Uint8Array(bits)));
  return constantTimeEqual(computedB64, hashB64);
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(bytes = 32) {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))));
}

/* Schema detection */

let _schemaCache = null;

async function getSchema(env) {
  if (_schemaCache) return _schemaCache;
  try {
    const info = await env.DB.prepare("SELECT name FROM pragma_table_info('products')").all();
    const cols = new Set(info.results.map((r) => r.name));
    _schemaCache = {
      hasCategoryId: cols.has('category_id'),
      hasArchived: cols.has('archived_at'),
    };
  } catch {
    _schemaCache = { hasCategoryId: false, hasArchived: false };
  }
  return _schemaCache;
}

function slugify(s) {
  return String(s || 'general').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'general';
}

async function ensureCategoryId(env, name) {
  name = (name || 'General').trim() || 'General';
  const existing = await env.DB.prepare(
    'SELECT id FROM categories WHERE name = ? LIMIT 1'
  ).bind(name).first();
  if (existing?.id) return existing.id;

  const newId = crypto.randomUUID();
  try {
    await env.DB.prepare(
      'INSERT INTO categories (id, name, slug) VALUES (?,?,?)'
    ).bind(newId, name, slugify(name)).run();
    return newId;
  } catch {
    const fb = await env.DB.prepare(
      'SELECT id FROM categories WHERE name = ? OR slug = ? LIMIT 1'
    ).bind(name, slugify(name)).first();
    return fb?.id || null;
  }
}

/* Admin products */

async function adminListProducts(request, env, cors) {
  if (!(await requireAdmin(request, env)))
    return json({ error: 'Unauthorized' }, 401, cors);

  const { results } = await env.DB.prepare(
    'SELECT * FROM products ORDER BY created_at DESC'
  ).all();

  const withProfit = results.map((p) => {
    const profit = (p.selling_price || 0) - (p.supplier_cost || 0);
    const margin = p.selling_price > 0 ? (profit / p.selling_price) * 100 : 0;
    return {
      ...p,
      estimated_profit: profit,
      profit_margin_pct: Number(margin.toFixed(2)),
    };
  });

  return json(withProfit, 200, cors);
}

function dedupeImages(arr) {
  const out = [];
  const seen = new Set();
  for (const url of arr) {
    if (typeof url !== 'string' || !url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

async function adminCreateProduct(request, env, cors) {
  if (!(await requireAdmin(request, env)))
    return json({ error: 'Unauthorized' }, 401, cors);

  const b = await request.json().catch(() => null);
  const err = validateProduct(b);
  if (err) return json({ error: err }, 400, cors);

  const schema = await getSchema(env);
  const categoryName = (b.category || 'General').trim() || 'General';
  let categoryIdValue = null;

  if (schema.hasCategoryId) {
    categoryIdValue = await ensureCategoryId(env, categoryName);
    if (!categoryIdValue)
      return json({ error: 'Could not resolve category' }, 500, cors);
  }

  const images = dedupeImages(b.images || []);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const primary = images[0] || b.image_url || '';
  const isAvailable = b.is_available === undefined ? 1 : (b.is_available ? 1 : 0);

  if (schema.hasCategoryId) {
    await env.DB.prepare(
      `INSERT INTO products (id, name, description, image_url, images, category, category_id,
        selling_price, supplier_cost, variants, sold_count, is_available, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id, b.name, b.description || '', primary, JSON.stringify(images),
      categoryName, categoryIdValue, b.selling_price, b.supplier_cost || 0,
      JSON.stringify(b.variants || []), b.sold_count || 0,
      isAvailable, now, now
    ).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO products (id, name, description, image_url, images, category,
        selling_price, supplier_cost, variants, sold_count, is_available, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id, b.name, b.description || '', primary, JSON.stringify(images),
      categoryName, b.selling_price, b.supplier_cost || 0,
      JSON.stringify(b.variants || []), b.sold_count || 0,
      isAvailable, now, now
    ).run();
  }

  return json({ id }, 201, cors);
}

async function adminUpdateProduct(request, env, id, cors) {
  if (!(await requireAdmin(request, env)))
    return json({ error: 'Unauthorized' }, 401, cors);

  const existing = await env.DB.prepare(
    'SELECT id, images FROM products WHERE id = ?'
  ).bind(id).first();
  if (!existing) return json({ error: 'Product not found' }, 404, cors);

  const b = await request.json().catch(() => null);
  const err = validateProduct(b);
  if (err) return json({ error: err }, 400, cors);

  const schema = await getSchema(env);
  const categoryName = (b.category || 'General').trim() || 'General';
  let categoryIdValue = null;

  if (schema.hasCategoryId) {
    categoryIdValue = await ensureCategoryId(env, categoryName);
    if (!categoryIdValue)
      return json({ error: 'Could not resolve category' }, 500, cors);
  }

  const images = dedupeImages(b.images || []);
  const primary = images[0] || b.image_url || '';
  const isAvailable = b.is_available === undefined ? 1 : (b.is_available ? 1 : 0);

  if (schema.hasCategoryId) {
    await env.DB.prepare(
      `UPDATE products SET name=?, description=?, image_url=?, images=?, category=?, category_id=?,
        selling_price=?, supplier_cost=?, variants=?, sold_count=?, is_available=?, updated_at=?
       WHERE id=?`
    ).bind(
      b.name, b.description || '', primary, JSON.stringify(images),
      categoryName, categoryIdValue, b.selling_price, b.supplier_cost || 0,
      JSON.stringify(b.variants || []), b.sold_count || 0, isAvailable,
      Math.floor(Date.now() / 1000), id
    ).run();
  } else {
    await env.DB.prepare(
      `UPDATE products SET name=?, description=?, image_url=?, images=?, category=?,
        selling_price=?, supplier_cost=?, variants=?, sold_count=?, is_available=?, updated_at=?
       WHERE id=?`
    ).bind(
      b.name, b.description || '', primary, JSON.stringify(images),
      categoryName, b.selling_price, b.supplier_cost || 0,
      JSON.stringify(b.variants || []), b.sold_count || 0, isAvailable,
      Math.floor(Date.now() / 1000), id
    ).run();
  }

  // ImageKit file IDs are not stored in the current schema; keep removed assets rather than deleting unsafely.
  return json({ ok: true, cleaned_up: 0 }, 200, cors);
}
async function adminDeleteProduct(request, env, id, cors) {
  if (!(await requireAdmin(request, env)))
    return json({ error: 'Unauthorized' }, 401, cors);

  const existing = await env.DB.prepare(
    'SELECT id, images FROM products WHERE id = ?'
  ).bind(id).first();
  if (!existing) return json({ error: 'Product not found' }, 404, cors);

  const schema = await getSchema(env);

  const archiveSql = schema.hasArchived
    ? `UPDATE products SET is_available = 0, archived_at = ?
       WHERE id = ? AND (
         EXISTS (SELECT 1 FROM order_items WHERE product_id = products.id)
         OR EXISTS (SELECT 1 FROM product_reviews WHERE product_id = products.id)
       )`
    : `UPDATE products SET is_available = 0
       WHERE id = ? AND (
         EXISTS (SELECT 1 FROM order_items WHERE product_id = products.id)
         OR EXISTS (SELECT 1 FROM product_reviews WHERE product_id = products.id)
       )`;

  const archiveBind = schema.hasArchived
    ? [Math.floor(Date.now() / 1000), id]
    : [id];

  const deleteSql = `DELETE FROM products WHERE id = ?
    AND NOT EXISTS (SELECT 1 FROM order_items WHERE product_id = products.id)
    AND NOT EXISTS (SELECT 1 FROM product_reviews WHERE product_id = products.id)`;

  try {
    await env.DB.batch([
      env.DB.prepare(archiveSql).bind(...archiveBind),
      env.DB.prepare(deleteSql).bind(id),
    ]);
  } catch {
    return json({ error: 'Could not delete product. Please retry.' }, 500, cors);
  }

  const stillExists = await env.DB.prepare(
    'SELECT id FROM products WHERE id = ?'
  ).bind(id).first();

  if (stillExists) {
    const orderRefs = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM order_items WHERE product_id = ?'
    ).bind(id).first();

    const reviewRefs = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM product_reviews WHERE product_id = ?'
    ).bind(id).first();

    const oc = orderRefs?.n ?? 0;
    const rc = reviewRefs?.n ?? 0;
    const parts = [];

    if (oc > 0) parts.push(`${oc} order item${oc === 1 ? '' : 's'}`);
    if (rc > 0) parts.push(`${rc} review${rc === 1 ? '' : 's'}`);

    return json({
      ok: true,
      soft_deleted: true,
      order_count: oc,
      review_count: rc,
      message: `Product archived (not deleted) because it appears in ${parts.join(' and ')}. Historical data preserved.`,
    }, 200, cors);
  }

  try {
    const orphans = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM order_items WHERE product_id = ? AND NOT EXISTS (SELECT 1 FROM products WHERE id = ?)'
    ).bind(id, id).first();

    if ((orphans?.n ?? 0) > 0) {
      console.error('ORPHAN_ORDER_ITEMS_AFTER_DELETE',
        JSON.stringify({ productId: id, count: orphans.n }));
    }
  } catch {}

  // Product images are retained in ImageKit; current DB schema stores URLs, not ImageKit file IDs.
  return json({ ok: true, deleted: true }, 200, cors);
}

async function adminToggleAvailability(request, env, id, cors) {
  if (!(await requireAdmin(request, env)))
    return json({ error: 'Unauthorized' }, 401, cors);

  const b = await request.json().catch(() => null);
  if (!b || typeof b.is_available !== 'boolean')
    return json({ error: 'is_available must be boolean' }, 400, cors);

  const result = await env.DB.prepare(
    'UPDATE products SET is_available = ?, updated_at = ? WHERE id = ?'
  ).bind(b.is_available ? 1 : 0, Math.floor(Date.now() / 1000), id).run();

  if (result.meta.changes === 0)
    return json({ error: 'Product not found' }, 404, cors);

  return json({ ok: true }, 200, cors);
}

function validateImageUrl(url) {
  if (!url) return null;
  if (typeof url !== 'string') return 'Image URL must be a string';
  if (url.length > 500) return 'Image URL too long (max 500 characters)';
  try {
    if (new URL(url).protocol !== 'https:')
      return 'Image URL must start with https://';
  } catch {
    return 'Invalid image URL';
  }
  return null;
}

function validateProduct(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b))
    return 'Invalid body';
  if (typeof b.name !== 'string' || !b.name.trim())
    return 'Name required';
  if (b.name.length > 200) return 'Name too long';

  if (!Number.isInteger(b.selling_price) || b.selling_price < 1)
    return 'Selling price must be at least ₹1 (100 paise)';

  if (b.supplier_cost !== undefined && b.supplier_cost !== null) {
    if (!Number.isInteger(b.supplier_cost) || b.supplier_cost < 0)
      return 'Invalid supplier cost (paise)';
    if (b.supplier_cost > b.selling_price)
      return 'Supplier cost cannot exceed selling price';
  }

  if (b.sold_count !== undefined && b.sold_count !== null) {
    if (!Number.isInteger(b.sold_count) || b.sold_count < 0 || b.sold_count > 1_000_000)
      return 'Sold count must be an integer between 0 and 1,000,000';
  }

  if (b.variants !== undefined && b.variants !== null) {
    if (!Array.isArray(b.variants)) return 'Variants must be an array';
    if (b.variants.length > 30) return 'Too many variants';
    for (const v of b.variants) {
      if (typeof v !== 'string' || !v.trim() || v.length > 100)
        return 'Each variant must be a non-empty string (max 100 chars)';
    }
  }

  if (b.description !== undefined && b.description !== null) {
    if (typeof b.description !== 'string' || b.description.length > 2000)
      return 'Invalid or too-long description';
  }

  if (b.is_available !== undefined && typeof b.is_available !== 'boolean')
    return 'is_available must be boolean';

  const urlErr = validateImageUrl(b.image_url);
  if (urlErr) return urlErr;

  if (b.images !== undefined && b.images !== null) {
    if (!Array.isArray(b.images)) return 'images must be an array';
    for (const u of b.images) {
      if (typeof u !== 'string') return 'Each image must be a string URL';
    }
    const deduped = dedupeImages(b.images);
    if (deduped.length > 10) return 'Maximum 10 images per product';
    for (const u of deduped) {
      const e = validateImageUrl(u);
      if (e) return e;
    }
  }

  if (b.category !== undefined && b.category !== null) {
    if (typeof b.category !== 'string' || b.category.length > 80)
      return 'Invalid or too-long category';
  }

  return null;
}

/* Image upload */

async function countProductImages(env, productId) {
  const product = await env.DB.prepare(
    'SELECT image_url, images FROM products WHERE id = ?'
  ).bind(productId).first();

  const urls = new Set();
  if (product) {
    if (typeof product.image_url === 'string' && product.image_url) urls.add(product.image_url);
    try {
      const arr = JSON.parse(product.images || '[]');
      if (Array.isArray(arr)) {
        for (const url of arr) {
          if (typeof url === 'string' && url) urls.add(url);
        }
      }
    } catch {}
  }
  return { saved: urls.size, pending: 0, total: urls.size };
}
async function adminUploadImage(request, env, productId, cors) {
  if (!(await requireAdmin(request, env)))
    return json({ error: 'Unauthorized' }, 401, cors);
  if (!env.IMAGEKIT_PRIVATE_KEY || !env.IMAGEKIT_URL_ENDPOINT)
    return json({ error: 'ImageKit is not configured. Check Worker secrets and variables.' }, 503, cors);

  const product = await env.DB.prepare(
    'SELECT id FROM products WHERE id = ?'
  ).bind(productId).first();
  if (!product) return json({ error: 'Product not found' }, 404, cors);

  const pre = await countProductImages(env, productId);
  if (pre.total >= 10) {
    return json({
      error: `Maximum 10 images per product. Current saved count: ${pre.saved}.`,
      current: pre.total, saved: pre.saved, pending: 0, limit: 10,
    }, 400, cors);
  }

  let formData;
  try { formData = await request.formData(); }
  catch { return json({ error: 'Invalid multipart body' }, 400, cors); }

  const file = formData.get('file');
  if (!file || typeof file === 'string')
    return json({ error: 'No file in request' }, 400, cors);
  if (!file.size || file.size > 5 * 1024 * 1024)
    return json({ error: 'File must be between 1 byte and 5 MB.' }, 400, cors);

  const buffer = await file.arrayBuffer();
  const detected = detectImageType(new Uint8Array(buffer.slice(0, 12)));
  if (!detected)
    return json({ error: 'Unsupported file type. Use JPG, PNG, or WebP.' }, 400, cors);

  const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  const safeName = `product-${productId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extMap[detected]}`;
  const outgoing = new FormData();
  outgoing.append('file', new Blob([buffer], { type: detected }), safeName);
  outgoing.append('fileName', safeName);
  outgoing.append('folder', `/aavora/products/${productId}`);
  outgoing.append('useUniqueFileName', 'true');
  outgoing.append('overwriteFile', 'false');

  const auth = btoa(`${env.IMAGEKIT_PRIVATE_KEY}:`);
  let response;
  try {
    response = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
      body: outgoing,
    });
  } catch {
    return json({ error: 'Could not connect to ImageKit. Please retry.' }, 502, cors);
  }

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof result.message === 'string' ? result.message : 'ImageKit upload failed';
    return json({ error: message.slice(0, 240) }, response.status >= 500 ? 502 : 400, cors);
  }
  if (!result.url || !result.fileId)
    return json({ error: 'ImageKit returned an incomplete upload response.' }, 502, cors);

  return json({
    key: result.fileId,
    file_id: result.fileId,
    url: result.url,
    size: result.size || file.size,
    content_type: detected,
  }, 201, cors);
}
function detectImageType(bytes) {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF)
    return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 &&
      bytes[2] === 0x4E && bytes[3] === 0x47)
    return 'image/png';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 &&
      bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 &&
      bytes[10] === 0x42 && bytes[11] === 0x50)
    return 'image/webp';
  return null;
}

async function adminDeleteOrphanImage(request, env, productId, cors) {
  if (!(await requireAdmin(request, env)))
    return json({ error: 'Unauthorized' }, 401, cors);
  if (!env.IMAGEKIT_PRIVATE_KEY)
    return json({ error: 'ImageKit is not configured.' }, 503, cors);

  const body = await request.json().catch(() => null);
  if (!body || typeof body.key !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(body.key))
    return json({ error: 'A valid ImageKit file ID is required.' }, 400, cors);

  const ref = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM products WHERE images LIKE ? OR image_url LIKE ?'
  ).bind(`%${body.key}%`, `%${body.key}%`).first();
  if ((ref?.n ?? 0) > 0)
    return json({ error: 'Image is referenced by a saved product; remove it from the product first.' }, 409, cors);

  const auth = btoa(`${env.IMAGEKIT_PRIVATE_KEY}:`);
  let response;
  try {
    response = await fetch(`https://api.imagekit.io/v1/files/${encodeURIComponent(body.key)}`, {
      method: 'DELETE',
      headers: { Authorization: `Basic ${auth}` },
    });
  } catch {
    return json({ error: 'Could not connect to ImageKit.' }, 502, cors);
  }
  if (!response.ok && response.status !== 404)
    return json({ error: 'ImageKit could not delete this image.' }, 502, cors);
  return json({ ok: true }, 200, cors);
}
/* Admin — orders */

async function adminListOrders(request, env, cors) {
  if (!(await requireAdmin(request, env)))
    return json({ error: 'Unauthorized' }, 401, cors);

  const { results: orders } = await env.DB.prepare(
    'SELECT * FROM orders ORDER BY created_at DESC LIMIT 200'
  ).all();

  const { results: items } = await env.DB.prepare(
    'SELECT * FROM order_items ORDER BY rowid ASC'
  ).all();

  const byOrder = {};
  for (const it of items) {
    if (!byOrder[it.order_id]) byOrder[it.order_id] = [];
    byOrder[it.order_id].push(it);
  }

  return json(
    orders.map((o) => ({ ...o, items: byOrder[o.id] || [] })),
    200,
    cors
  );
}

async function adminGetOrder(request, env, id, cors) {
  if (!(await requireAdmin(request, env)))
    return json({ error: 'Unauthorized' }, 401, cors);

  const order = await env.DB.prepare(
    'SELECT * FROM orders WHERE id = ?'
  ).bind(id).first();

  if (!order) return json({ error: 'Order not found' }, 404, cors);

  const { results: items } = await env.DB.prepare(
    'SELECT * FROM order_items WHERE order_id = ?'
  ).bind(id).all();

  const { results: history } = await env.DB.prepare(
    'SELECT status, note, changed_at FROM order_status_history WHERE order_id = ? ORDER BY changed_at ASC'
  ).bind(id).all();

  return json({ ...order, items, history }, 200, cors);
}

async function adminUpdateOrderStatus(request, env, id, cors) {
  if (!(await requireAdmin(request, env)))
    return json({ error: 'Unauthorized' }, 401, cors);

  const b = await request.json().catch(() => null);
  const allowed = [
    'Pending', 'Contacted', 'Confirmed', 'Supplier Ordered',
    'Shipped', 'Delivered', 'Cancelled', 'Returned',
  ];

  if (!b || !allowed.includes(b.status))
    return json({ error: 'Invalid status' }, 400, cors);

  if (b.note !== undefined && b.note !== null && typeof b.note !== 'string')
    return json({ error: 'Invalid note' }, 400, cors);
  if (typeof b.note === 'string' && b.note.length > 300)
    return json({ error: 'Note too long (max 300 chars)' }, 400, cors);
  if (b.estimated_delivery !== undefined &&
      b.estimated_delivery !== null &&
      typeof b.estimated_delivery !== 'string')
    return json({ error: 'Invalid estimated_delivery' }, 400, cors);
  if (typeof b.estimated_delivery === 'string' &&
      b.estimated_delivery.length > 30)
    return json({ error: 'estimated_delivery too long (max 30 chars)' }, 400, cors);

  const existing = await env.DB.prepare(
    'SELECT id FROM orders WHERE id = ?'
  ).bind(id).first();

  if (!existing) return json({ error: 'Order not found' }, 404, cors);

  const now = Math.floor(Date.now() / 1000);
  const note = typeof b.note === 'string' ? b.note : null;
  const eta = typeof b.estimated_delivery === 'string'
    ? b.estimated_delivery
    : null;

  const updateSql = eta !== null
    ? 'UPDATE orders SET status = ?, estimated_delivery = ? WHERE id = ?'
    : 'UPDATE orders SET status = ? WHERE id = ?';

  const updateParams = eta !== null
    ? [b.status, eta, id]
    : [b.status, id];

  try {
    await env.DB.batch([
      env.DB.prepare(updateSql).bind(...updateParams),
      env.DB.prepare(
        'INSERT INTO order_status_history (id, order_id, status, note, changed_at) VALUES (?,?,?,?,?)'
      ).bind(crypto.randomUUID(), id, b.status, note, now),
    ]);
  } catch {
    return json({ error: 'Could not update order status. Please retry.' }, 500, cors);
  }

  return json({ ok: true }, 200, cors);
}

/* Admin — reviews */

async function adminListReviews(request, env, cors) {
  if (!(await requireAdmin(request, env)))
    return json({ error: 'Unauthorized' }, 401, cors);

  const { results } = await env.DB.prepare(
    'SELECT * FROM product_reviews ORDER BY created_at DESC LIMIT 500'
  ).all();

  return json(results, 200, cors);
}

async function adminCreateReview(request, env, cors) {
  if (!(await requireAdmin(request, env)))
    return json({ error: 'Unauthorized' }, 401, cors);

  const b = await request.json().catch(() => null);
  const err = validateReview(b);
  if (err) return json({ error: err }, 400, cors);

  const exists = await env.DB.prepare(
    'SELECT id FROM products WHERE id = ?'
  ).bind(b.product_id).first();

  if (!exists) return json({ error: 'Product not found' }, 404, cors);

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `INSERT INTO product_reviews (id, product_id, reviewer_name, rating, review_text,
      review_date, is_visible, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, b.product_id, b.reviewer_name, b.rating, b.review_text,
    b.review_date, b.is_visible ? 1 : 0, now, now
  ).run();

  return json({ id }, 201, cors);
}

async function adminUpdateReview(request, env, id, cors) {
  if (!(await requireAdmin(request, env)))
    return json({ error: 'Unauthorized' }, 401, cors);
  if (typeof id !== 'string' || id.length < 1 || id.length > 100)
    return json({ error: 'Invalid review id' }, 400, cors);

  const b = await request.json().catch(() => null);
  const err = validateReview(b);
  if (err) return json({ error: err }, 400, cors);

  const result = await env.DB.prepare(
    `UPDATE product_reviews SET product_id=?, reviewer_name=?, rating=?, review_text=?,
      review_date=?, is_visible=?, updated_at=? WHERE id=?`
  ).bind(
    b.product_id, b.reviewer_name, b.rating, b.review_text,
    b.review_date, b.is_visible ? 1 : 0,
    Math.floor(Date.now() / 1000), id
  ).run();

  if (result.meta.changes === 0)
    return json({ error: 'Review not found' }, 404, cors);

  return json({ ok: true }, 200, cors);
}

async function adminDeleteReview(request, env, id, cors) {
  if (!(await requireAdmin(request, env)))
    return json({ error: 'Unauthorized' }, 401, cors);
  if (typeof id !== 'string' || id.length < 1 || id.length > 100)
    return json({ error: 'Invalid review id' }, 400, cors);

  const result = await env.DB.prepare(
    'DELETE FROM product_reviews WHERE id = ?'
  ).bind(id).run();

  if (result.meta.changes === 0)
    return json({ error: 'Review not found' }, 404, cors);

  return json({ ok: true }, 200, cors);
}

function validateReview(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b))
    return 'Invalid body';
  if (typeof b.product_id !== 'string' ||
      b.product_id.length < 1 || b.product_id.length > 100)
    return 'Invalid product ID';
  if (typeof b.reviewer_name !== 'string' || !b.reviewer_name.trim())
    return 'Reviewer name required';
  if (b.reviewer_name.length > 100)
    return 'Reviewer name too long';
  if (!Number.isInteger(b.rating) || b.rating < 1 || b.rating > 5)
    return 'Rating must be 1 to 5';
  if (typeof b.review_text !== 'string' || !b.review_text.trim())
    return 'Review text required';
  if (b.review_text.length > 2000)
    return 'Review text too long';
  if (typeof b.review_date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(b.review_date))
    return 'Review date must be YYYY-MM-DD';
  if (b.is_visible !== undefined && typeof b.is_visible !== 'boolean')
    return 'is_visible must be boolean';

  return null;
}
