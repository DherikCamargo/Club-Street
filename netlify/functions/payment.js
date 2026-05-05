// ── Variáveis de ambiente (seguras, não expostas no GitHub) ──
const ACCESS_TOKEN   = process.env.MP_ACCESS_TOKEN;
const OWNER_PHONE    = process.env.OWNER_PHONE;
const CALLMEBOT_APIKEY = process.env.CALLMEBOT_APIKEY;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_SECRET = process.env.SUPABASE_SECRET;
const ADMIN_KEY      = process.env.ADMIN_KEY;

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const body = JSON.parse(event.body);
    const { action, cartItems, paymentData, orderData } = body;

    // ── Salvar pedido no Supabase ─────────────────────────────
    if (action === 'save_order') {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_SECRET}`,
          'apikey': SUPABASE_SECRET,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          id: orderData.id,
          customer_id: orderData.customerId,
          date: orderData.date,
          total: orderData.total,
          status: orderData.status || 'pending',
          items: orderData.items
        })
      });
      const data = await response.json();
      if (!response.ok) return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: data }) };
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // ── Buscar pedidos do cliente ─────────────────────────────
    if (action === 'get_orders') {
      const { customerId } = body;
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/orders?customer_id=eq.${customerId}&order=created_at.desc`,
        {
          headers: {
            'Authorization': `Bearer ${SUPABASE_SECRET}`,
            'apikey': SUPABASE_SECRET,
            'Content-Type': 'application/json'
          }
        }
      );
      const data = await response.json();
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, orders: data }) };
    }

    // ── Atualizar status (painel admin) ───────────────────────
    if (action === 'update_status') {
      const { orderId, status, adminKey } = body;
      if (adminKey !== ADMIN_KEY) {
        return { statusCode: 403, headers, body: JSON.stringify({ success: false, error: 'Não autorizado' }) };
      }
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${SUPABASE_SECRET}`,
            'apikey': SUPABASE_SECRET,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify({ status })
        }
      );
      const data = await response.json();
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, order: data[0] }) };
    }

    // ── Buscar todos pedidos (admin) ──────────────────────────
    if (action === 'get_all_orders') {
      const { adminKey } = body;
      if (adminKey !== ADMIN_KEY) {
        return { statusCode: 403, headers, body: JSON.stringify({ success: false, error: 'Não autorizado' }) };
      }
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/orders?order=created_at.desc`,
        {
          headers: {
            'Authorization': `Bearer ${SUPABASE_SECRET}`,
            'apikey': SUPABASE_SECRET,
            'Content-Type': 'application/json'
          }
        }
      );
      const data = await response.json();
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, orders: data }) };
    }

    // ── Notificar lojista via CallMeBot ───────────────────────
    if (action === 'notify_owner') {
      const lines = orderData.items.map(i =>
        `- ${i.title} | ${i.color} | Tam. ${i.size} | Qtd: ${i.quantity}`
      ).join('%0A');
      const msg = encodeURIComponent(
        `NOVO PEDIDO #${orderData.id}\nData: ${orderData.date}\nTotal: ${orderData.total}\n\nItens:\n`
      ) + lines + encodeURIComponent('\n\nPagamento confirmado via Mercado Pago.');
      const url = `https://api.callmebot.com/whatsapp.php?phone=${OWNER_PHONE}&text=${msg}&apikey=${CALLMEBOT_APIKEY}`;
      await fetch(url);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // ── Criar preferência ─────────────────────────────────────
    if (action === 'create_preference') {
      const items = cartItems.map(item => ({
        id: `${item.id}-${item.color}-${item.size}`,
        title: `${item.title} | ${item.color} | Tam. ${item.size}`,
        quantity: Number(item.quantity),
        unit_price: Number(item.price),
        currency_id: 'BRL',
        category_id: 'fashion'
      }));
      const preference = {
        items,
        back_urls: {
          success: `${event.headers.origin || 'https://club-street.netlify.app'}?status=success`,
          failure: `${event.headers.origin || 'https://club-street.netlify.app'}?status=failure`,
          pending: `${event.headers.origin || 'https://club-street.netlify.app'}?status=pending`
        },
        auto_return: 'approved',
        statement_descriptor: 'CLUB STREET',
        external_reference: `order-${Date.now()}`
      };
      const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(preference)
      });
      const data = await response.json();
      if (data.error) return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: data.message }) };
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, preferenceId: data.id }) };
    }

    // ── Processar pagamento ───────────────────────────────────
    if (action === 'process_payment') {
      const response = await fetch('https://api.mercadopago.com/v1/payments', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': `${Date.now()}-${Math.random()}`
        },
        body: JSON.stringify(paymentData)
      });
      const data = await response.json();
      if (data.status === 'approved') {
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, status: 'approved', message: 'Pagamento aprovado!' }) };
      }
      if ((data.status === 'pending' || data.status === 'in_process') && data.payment_method_id === 'pix') {
        const txData = data.point_of_interaction?.transaction_data;
        return { statusCode: 200, headers, body: JSON.stringify({
          success: true, status: 'pix',
          qrCode: txData?.qr_code || '',
          qrCodeBase64: txData?.qr_code_base64 || '',
          message: 'Escaneie o QR Code ou copie o código Pix.'
        })};
      }
      if (data.status === 'pending') {
        const boletoUrl = data.transaction_details?.external_resource_url || '';
        if (boletoUrl) return { statusCode: 200, headers, body: JSON.stringify({ success: true, status: 'boleto', boletoUrl, message: 'Seu boleto foi gerado!' }) };
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, status: 'pending', message: 'Pagamento em processamento.' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, status: data.status, message: 'Pagamento não aprovado. Tente outro método.' }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Ação inválida.' }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
