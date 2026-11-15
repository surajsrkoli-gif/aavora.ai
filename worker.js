/* Order creation */

async function createOrder(request, env, cors) {
  const limited = await env.ORDER_RATE_LIMITER.limit({
    key: clientIp(request),
  });

  if (!limited.success) {
    return json({
      error: 'Too many requests. Please wait a minute.',
    }, 429, cors);
  }

  const body = await request.json().catch(() => null);
  const err = validateOrderFields(body);
  if (err) return json({ error: err }, 400, cors);

  const uniqueIds = [...new Set(body.items.map((i) => i.product_id))];
  const placeholders = uniqueIds.map(() => '?').join(',');

  const { results: productRows } = await env.DB.prepare(
    `SELECT id, name, selling_price, variants
     FROM products
     WHERE id IN (${placeholders}) AND is_available = 1`
  ).bind(...uniqueIds).all();

  if (productRows.length !== uniqueIds.length) {
    return json({
      error: 'One or more products are unavailable',
    }, 400, cors);
  }

  const map = new Map(productRows.map((p) => [p.id, p]));
  let computedTotal = 0;
  const lineItems = [];

  for (const item of body.items) {
    const p = map.get(item.product_id);
    let allowed = [];

    try {
      allowed = JSON.parse(p.variants || '[]');
    } catch {}

    if (!allowed.length) allowed = ['Default'];

    if (!allowed.includes(item.variant)) {
      return json({
        error: `Invalid variant for ${p.name}`,
      }, 400, cors);
    }

    const unitPrice = Number(p.selling_price);
    const lineTotal = unitPrice * item.quantity;

    computedTotal += lineTotal;

    lineItems.push({
      id: crypto.randomUUID(),
      product_id: p.id,
      product_name: p.name,
      variant: item.variant,
      quantity: item.quantity,
      unit_price: unitPrice,
      line_total: lineTotal,
    });
  }

  const orderId = crypto.randomUUID();
  const now = new Date().toISOString();

  const statements = [
    env.DB.prepare(
      `INSERT INTO orders (
        id, customer_name, phone, email, address, city, state,
        pincode, total_amount, payment_method, payment_status,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'COD',
                'pending', 'placed', ?, ?)`
    ).bind(
      orderId,
      body.customer_name.trim(),
      body.phone.trim(),
      body.email || null,
      body.address.trim(),
      body.city.trim(),
      body.state.trim(),
      body.pincode.trim(),
      computedTotal,
      now,
      now
    ),
  ];

  for (const item of lineItems) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO order_items (
          id, order_id, product_id, product_name, variant,
          quantity, unit_price, line_total
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        item.id,
        orderId,
        item.product_id,
        item.product_name,
        item.variant,
        item.quantity,
        item.unit_price,
        item.line_total
      )
    );
  }

  statements.push(
    env.DB.prepare(
      `INSERT INTO order_status_history (
        id, order_id, status, note
      ) VALUES (?, ?, 'placed', 'Order placed by customer')`
    ).bind(crypto.randomUUID(), orderId)
  );

  await env.DB.batch(statements);

  return json({
    success: true,
    order_id: orderId,
    total_amount: computedTotal,
    payment_method: 'COD',
    message: 'Order placed successfully',
  }, 201, cors);
}

function validateOrderFields(body) {
  if (!body || typeof body !== 'object')
    return 'Invalid request';

  const required = [
    'customer_name',
    'phone',
    'address',
    'city',
    'state',
    'pincode',
  ];

  for (const key of required) {
    if (typeof body[key] !== 'string' || !body[key].trim()) {
      return `${key} is required`;
    }
  }

  if (!/^[6-9]\d{9}$/.test(body.phone.trim()))
    return 'Enter a valid 10-digit Indian mobile number';

  if (!/^\d{6}$/.test(body.pincode.trim()))
    return 'Enter a valid 6-digit PIN code';

  if (!Array.isArray(body.items) ||
      body.items.length < 1 ||
      body.items.length > 20) {
    return 'Cart must contain between 1 and 20 items';
  }

  for (const item of body.items) {
    if (!item ||
        typeof item.product_id !== 'string' ||
        typeof item.variant !== 'string' ||
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > 20) {
      return 'Invalid cart item';
    }
  }

  if (body.email &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    return 'Enter a valid email address';
  }

  return null;
}

/* Customer order tracking */

async function trackOrder(request, env, cors) {
  const body = await request.json().catch(() => null);

  if (!body ||
      typeof body.order_id !== 'string' ||
      typeof body.phone !== 'string') {
    return json({ error: 'Order ID and phone are required' }, 400, cors);
  }

  const order = await env.DB.prepare(
    `SELECT id, customer_name, total_amount, status,
            payment_method, payment_status, created_at,
            updated_at
     FROM orders
     WHERE id = ? AND phone = ?`
  ).bind(body.order_id.trim(), body.phone.trim()).first();

  if (!order) {
    return json({ error: 'Order not found' }, 404, cors);
  }

  const { results: items } = await env.DB.prepare(
    `SELECT product_name, variant, quantity, unit_price, line_total
     FROM order_items
     WHERE order_id = ?`
  ).bind(order.id).all();

  const { results: history } = await env.DB.prepare(
    `SELECT status, note, changed_at
     FROM order_status_history
     WHERE order_id = ?
     ORDER BY changed_at ASC`
  ).bind(order.id).all();

  return json({
    order,
    items,
    history,
  }, 200, cors);
}

/* Password utilities */

async function hashPassword(password, salt) {
  const enc = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    salt: enc.encode(salt),
    iterations: 210000,
    hash: 'SHA-256',
  }, key, 256);

  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

function randomToken(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));

  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  );

  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
