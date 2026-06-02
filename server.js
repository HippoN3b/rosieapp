require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FREE_QUESTIONS = 3;
const DB_FILE = path.join(__dirname, 'data.json');

// ── Database ──────────────────────────────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ users: {} }));
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

function getUser(deviceId) {
  const db = loadDB();
  if (!db.users[deviceId]) {
    db.users[deviceId] = {
      deviceId,
      questionsUsed: 0,
      isPaid: false,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      createdAt: new Date().toISOString()
    };
    saveDB(db);
  }
  return db.users[deviceId];
}

function updateUser(deviceId, fields) {
  const db = loadDB();
  db.users[deviceId] = { ...db.users[deviceId], ...fields };
  saveDB(db);
  return db.users[deviceId];
}

// ── Middleware ────────────────────────────────────────────────────────
app.use(cors());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') next();
  else express.json()(req, res, next);
});

const SYSTEM_PROMPT = `You are Rosie, a sweet and patient computer helper designed for older adults and grandmothers who are not very tech-savvy.
You are warm, encouraging, and speak like a kind neighbor — never condescending. Use simple, everyday language with NO technical jargon.
If you must use a technical term, immediately explain it in plain words.
Keep answers to 2-4 sentences. Be reassuring — nothing is a silly question.
Occasionally use gentle phrases like "Oh, that's easy!" or "Don't worry, dear" or "You're doing great!".
No markdown. Plain warm text only.`;

// ── Routes ────────────────────────────────────────────────────────────

app.post('/status', (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const user = getUser(deviceId);
  res.json({
    questionsRemaining: user.isPaid ? 999 : Math.max(0, FREE_QUESTIONS - user.questionsUsed),
    isPaid: user.isPaid
  });
});

app.post('/ask', async (req, res) => {
  const { deviceId, question, history } = req.body;
  if (!deviceId || !question) return res.status(400).json({ error: 'deviceId and question required' });
  const user = getUser(deviceId);
  if (!user.isPaid && user.questionsUsed >= FREE_QUESTIONS) {
    return res.status(402).json({ error: 'free_limit_reached', message: 'free_limit_reached' });
  }
  try {
    const messages = [...(history || []), { role: 'user', content: question }];
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages
    });
    const answer = response.content[0].text;
    if (!user.isPaid) updateUser(deviceId, { questionsUsed: user.questionsUsed + 1 });
    const updated = getUser(deviceId);
    res.json({
      answer,
      questionsRemaining: updated.isPaid ? 999 : Math.max(0, FREE_QUESTIONS - updated.questionsUsed),
      isPaid: updated.isPaid
    });
  } catch (err) {
    console.error('Claude error:', err);
    res.status(500).json({ error: 'Failed to get response' });
  }
});

app.post('/subscribe', async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  try {
    const user = getUser(deviceId);
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ metadata: { deviceId } });
      customerId = customer.id;
      updateUser(deviceId, { stripeCustomerId: customerId });
    }
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${process.env.APP_URL}/success?session_id={CHECKOUT_SESSION_ID}&deviceId=${deviceId}`,
      cancel_url: `${process.env.APP_URL}/cancel`,
      metadata: { deviceId }
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: 'Failed to create checkout' });
  }
});

app.get('/success', async (req, res) => {
  const { session_id, deviceId } = req.query;
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status === 'paid') {
      updateUser(deviceId, { isPaid: true, stripeSubscriptionId: session.subscription });
    }
  } catch(e) { console.error(e); }
  res.send(`
    <html><head><style>
      body{font-family:Georgia,serif;background:#FFF5F7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
      .box{text-align:center;padding:40px;background:white;border-radius:20px;border:2px solid #E8A0B0;box-shadow:0 4px 20px rgba(200,100,120,0.2)}
      h1{color:#D4788A}p{color:#7a3040}
    </style></head><body>
      <div class="box"><h1>🌸 Thank you!</h1><p>You're all set! Close this window and go back to Rosie.</p></div>
    </body></html>
  `);
});

app.get('/cancel', (req, res) => {
  res.send(`
    <html><head><style>
      body{font-family:Georgia,serif;background:#FFF5F7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
      .box{text-align:center;padding:40px;background:white;border-radius:20px;border:2px solid #E8A0B0}
      h1{color:#D4788A}p{color:#7a3040}
    </style></head><body>
      <div class="box"><h1>No worries! 🌸</h1><p>Close this window and go back to Rosie.</p></div>
    </body></html>
  `);
});

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const db = loadDB();
    const user = Object.values(db.users).find(u => u.stripeSubscriptionId === sub.id);
    if (user) updateUser(user.deviceId, { isPaid: false, stripeSubscriptionId: null });
  }
  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    const db = loadDB();
    const user = Object.values(db.users).find(u => u.stripeCustomerId === invoice.customer);
    if (user) updateUser(user.deviceId, { isPaid: false });
  }
  res.json({ received: true });
});

app.post('/cancel', async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  try {
    const user = getUser(deviceId);
    if (!user.stripeSubscriptionId) return res.status(400).json({ error: 'No active subscription' });
    await stripe.subscriptions.cancel(user.stripeSubscriptionId);
    updateUser(deviceId, { isPaid: false, stripeSubscriptionId: null });
    res.json({ success: true });
  } catch(err) {
    console.error('Cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rosie server on port ${PORT}`));
