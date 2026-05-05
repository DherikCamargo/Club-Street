const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ACCESS_TOKEN    = process.env.MP_ACCESS_TOKEN;
const OWNER_PHONE     = process.env.OWNER_PHONE;
const CALLMEBOT_APIKEY = process.env.CALLMEBOT_APIKEY;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_SECRET = process.env.SUPABASE_SECRET;
const ADMIN_KEY       = process.env.ADMIN_KEY;
const PORT            = process.env.PORT || 3000;

// ── Helpers ────────────────────────────────────────────────
function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, function(err, data) {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

async function handlePayment(body, req, res) {
  const { action, cartItems, paymentData, orderData } = body;
  const origin = (req.headers.origin || 'https://club-street.onrender.com');

  // ── Salvar pedido ─────────────────────────────────────────
  if (action === 'save_order') {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SUPABASE_SECRET}`, 'apikey': SUPABASE_SECRET, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ id: orderData.id, customer_id: orderData.customerId, date: orderData.date, total: orderData.total, status: orderData.status || 'pending', items: orderData.items })
    });
    const d = await r.json();
    return jsonResponse(res, r.ok ? 200 : 400, r.ok ? { success: true } : { success: false, error: d });
  }

  // ── Buscar pedidos do cliente ─────────────────────────────
  if (action === 'get_orders') {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/orders?customer_id=eq.${body.customerId}&order=created_at.desc`, {
      headers: { 'Authorization': `Bearer ${SUPABASE_SECRET}`, 'apikey': SUPABASE_SECRET }
    });
    const d = await r.json();
    return jsonResponse(res, 200, { success: true, orders: d });
  }

  // ── Atualizar status (admin) ──────────────────────────────
  if (action === 'update_status') {
    if (body.adminKey !== ADMIN_KEY) return jsonResponse(res, 403, { success: false, error: 'Não autorizado' });
    const r = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${body.orderId}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${SUPABASE_SECRET}`, 'apikey': SUPABASE_SECRET, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ status: body.status })
    });
    const d = await r.json();
    return jsonResponse(res, 200, { success: true, order: d[0] });
  }

  // ── Buscar todos pedidos (admin) ──────────────────────────
  if (action === 'get_all_orders') {
    if (body.adminKey !== ADMIN_KEY) return jsonResponse(res, 403, { success: false, error: 'Não autorizado' });
    const r = await fetch(`${SUPABASE_URL}/rest/v1/orders?order=created_at.desc`, {
      headers: { 'Authorization': `Bearer ${SUPABASE_SECRET}`, 'apikey': SUPABASE_SECRET }
    });
    const d = await r.json();
    return jsonResponse(res, 200, { success: true, orders: d });
  }

  // ── Notificar lojista ─────────────────────────────────────
  if (action === 'notify_owner') {
    const lines = orderData.items.map(i => `- ${i.title} | ${i.color} | Tam. ${i.size} | Qtd: ${i.quantity}`).join('%0A');
    const msg = encodeURIComponent(`NOVO PEDIDO #${orderData.id}\nData: ${orderData.date}\nTotal: ${orderData.total}\n\nItens:\n`) + lines + encodeURIComponent('\n\nPagamento confirmado via Mercado Pago.');
    await fetch(`https://api.callmebot.com/whatsapp.php?phone=${OWNER_PHONE}&text=${msg}&apikey=${CALLMEBOT_APIKEY}`);
    return jsonResponse(res, 200, { success: true });
  }

  // ── Criar preferência ─────────────────────────────────────
  if (action === 'create_preference') {
    const items = cartItems.map(item => ({ id: `${item.id}-${item.color}-${item.size}`, title: `${item.title} | ${item.color} | Tam. ${item.size}`, quantity: Number(item.quantity), unit_price: Number(item.price), currency_id: 'BRL', category_id: 'fashion' }));
    const preference = { items, back_urls: { success: `${origin}?status=success`, failure: `${origin}?status=failure`, pending: `${origin}?status=pending` }, auto_return: 'approved', statement_descriptor: 'CLUB STREET', external_reference: `order-${Date.now()}` };
    const r = await fetch('https://api.mercadopago.com/checkout/preferences', { method: 'POST', headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(preference) });
    const d = await r.json();
    if (d.error) return jsonResponse(res, 400, { success: false, error: d.message });
    return jsonResponse(res, 200, { success: true, preferenceId: d.id });
  }

  // ── Processar pagamento ───────────────────────────────────
  if (action === 'process_payment') {
    const r = await fetch('https://api.mercadopago.com/v1/payments', { method: 'POST', headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json', 'X-Idempotency-Key': `${Date.now()}-${Math.random()}` }, body: JSON.stringify(paymentData) });
    const d = await r.json();
    if (d.status === 'approved') return jsonResponse(res, 200, { success: true, status: 'approved', message: 'Pagamento aprovado!' });
    if ((d.status === 'pending' || d.status === 'in_process') && d.payment_method_id === 'pix') {
      const tx = d.point_of_interaction?.transaction_data;
      return jsonResponse(res, 200, { success: true, status: 'pix', qrCode: tx?.qr_code || '', qrCodeBase64: tx?.qr_code_base64 || '' });
    }
    if (d.status === 'pending') {
      const boletoUrl = d.transaction_details?.external_resource_url || '';
      if (boletoUrl) return jsonResponse(res, 200, { success: true, status: 'boleto', boletoUrl, message: 'Boleto gerado!' });
      return jsonResponse(res, 200, { success: true, status: 'pending', message: 'Pagamento em processamento.' });
    }
    return jsonResponse(res, 200, { success: false, status: d.status, message: 'Pagamento não aprovado.' });
  }

  return jsonResponse(res, 400, { success: false, error: 'Ação inválida.' });
}

// ── Servidor ───────────────────────────────────────────────
const server = http.createServer(function(req, res) {
  const parsedUrl = url.parse(req.url);
  const pathname = parsedUrl.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' });
    res.end(); return;
  }

  // API endpoint
  if (pathname === '/api/payment' && req.method === 'POST') {
    let body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', async function() {
      try {
        const parsed = JSON.parse(body);
        await handlePayment(parsed, req, res);
      } catch(e) {
        jsonResponse(res, 500, { success: false, error: e.message });
      }
    });
    return;
  }

  // Servir arquivos estáticos
  const mimeTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath);
  const contentType = mimeTypes[ext] || 'text/plain';
  serveFile(res, filePath, contentType);
});

server.listen(PORT, function() {
  console.log('Club Street rodando na porta ' + PORT);
});
