const ACCESS_TOKEN = 'APP_USR-847572925562157-050415-10a68a81e0bc42b71175e43a109fdc41-218917038';
const OWNER_PHONE = '5516994451494';
const CALLMEBOT_APIKEY = '5575580';

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

    // ── Notificar lojista via CallMeBot ───────────────────────
    if (action === 'notify_owner') {
      const lines = orderData.items.map(i =>
        `- ${i.title} | ${i.color} | Tam. ${i.size} | Qtd: ${i.quantity}`
      ).join('%0A');

      const msg = encodeURIComponent(
        `NOVO PEDIDO #${orderData.id}\n` +
        `Data: ${orderData.date}\n` +
        `Total: ${orderData.total}\n\n` +
        `Itens:\n`
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
        headers: {
          'Authorization': `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
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
        if (boletoUrl) {
          return { statusCode: 200, headers, body: JSON.stringify({ success: true, status: 'boleto', boletoUrl, message: 'Seu boleto foi gerado!' }) };
        }
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, status: 'pending', message: 'Pagamento em processamento.' }) };
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: false, status: data.status, message: 'Pagamento não aprovado. Tente outro método.' }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Ação inválida.' }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
