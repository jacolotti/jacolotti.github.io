export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    const pulsePriceId = process.env.STRIPE_PULSE_PRICE_ID;
    const installerUrl = process.env.PULSE_INSTALLER_URL;
    const sessionId = String(req.query?.session_id || '').trim();

    if (!stripeSecretKey || !pulsePriceId || !installerUrl) {
      console.error('Pulse download configuration is incomplete.');
      return res.status(500).json({ error: 'Download is not configured' });
    }

    if (!sessionId.startsWith('cs_')) {
      return res.status(400).json({ error: 'Invalid Checkout Session' });
    }

    const sessionResponse = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      {
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`,
          Accept: 'application/json',
        },
      }
    );

    const sessionText = await sessionResponse.text();
    let session = null;
    try { session = JSON.parse(sessionText); } catch {}

    if (!sessionResponse.ok || !session) {
      console.error('Stripe Pulse download session lookup failed:', sessionResponse.status, sessionText);
      return res.status(403).json({ error: 'Purchase could not be verified' });
    }

    if (session.payment_status !== 'paid' || session.mode !== 'payment') {
      return res.status(403).json({ error: 'Completed payment required' });
    }

    const lineItemsResponse = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items?limit=100`,
      {
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`,
          Accept: 'application/json',
        },
      }
    );

    const lineItemsText = await lineItemsResponse.text();
    let lineItems = null;
    try { lineItems = JSON.parse(lineItemsText); } catch {}

    if (!lineItemsResponse.ok || !Array.isArray(lineItems?.data)) {
      console.error('Stripe Pulse download line item lookup failed:', lineItemsResponse.status, lineItemsText);
      return res.status(403).json({ error: 'Purchase items could not be verified' });
    }

    const purchasedPulse = lineItems.data.some((item) => {
      const priceId = typeof item?.price === 'string' ? item.price : item?.price?.id;
      return priceId === pulsePriceId && Number(item?.quantity || 0) > 0;
    });

    if (!purchasedPulse) {
      return res.status(403).json({ error: 'Colotti Pulse purchase required' });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, installerUrl);
  } catch (error) {
    console.error('Pulse download error:', error);
    return res.status(500).json({ error: 'Download verification failed' });
  }
}
