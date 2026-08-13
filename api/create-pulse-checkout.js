export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    const pulsePriceId = process.env.STRIPE_PULSE_PRICE_ID;

    if (!stripeSecretKey || !pulsePriceId) {
      console.error('Stripe checkout configuration is incomplete.');
      return res.status(500).json({ error: 'Checkout is not configured' });
    }

    const rawQuantity = req.body?.quantity ?? req.query?.quantity ?? 1;
    const quantity = Number.parseInt(String(rawQuantity), 10);

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 25) {
      return res.status(400).json({ error: 'Quantity must be between 1 and 25' });
    }

    const params = new URLSearchParams();
    params.set('line_items[0][price]', pulsePriceId);
    params.set('line_items[0][quantity]', String(quantity));
    params.set('mode', 'payment');
    params.set('managed_payments[enabled]', 'true');
    params.set(
      'success_url',
      'https://automationcalculators.net/pulse-success.html?session_id={CHECKOUT_SESSION_ID}'
    );
    params.set(
      'cancel_url',
      'https://automationcalculators.net/colotti-pulse.html#buy'
    );

    const stripeResponse = await fetch(
      'https://api.stripe.com/v1/checkout/sessions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Stripe-Version': '2026-03-04.preview',
        },
        body: params.toString(),
      }
    );

    const responseText = await stripeResponse.text();
    let session = null;

    try {
      session = JSON.parse(responseText);
    } catch {}

    if (!stripeResponse.ok || !session?.url) {
      console.error(
        'Stripe Checkout Session creation failed:',
        stripeResponse.status,
        responseText
      );

      return res.status(502).json({ error: 'Could not start secure checkout' });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(303, session.url);
  } catch (error) {
    console.error('Pulse checkout error:', error);
    return res.status(500).json({ error: 'Checkout failed' });
  }
}
