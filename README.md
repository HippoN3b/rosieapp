# Rosie Server

Backend for the Rosie desktop app. Handles AI calls, free question limits, and Stripe subscriptions.

---

## Deploy to Railway (free, takes 5 minutes)

1. Go to **railway.app** and sign up with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Push this `rosie-server` folder to a GitHub repo and connect it
4. In Railway, go to **Variables** and add these:

```
ANTHROPIC_API_KEY        your sk-ant- key
STRIPE_SECRET_KEY        sk_live_... (from Stripe dashboard)
STRIPE_PRICE_ID          price_... (see Stripe setup below)
STRIPE_WEBHOOK_SECRET    whsec_... (see Stripe setup below)
APP_URL                  https://your-app-name.railway.app
```

5. Railway auto-deploys. Copy your public URL (e.g. `https://rosie-xyz.railway.app`)
6. Paste that URL into `main.js` in the Electron app where it says `SERVER_URL`

---

## Stripe Setup

1. Go to **dashboard.stripe.com** and create an account
2. **Create a Product:**
   - Products → Add Product
   - Name: "Rosie Monthly"
   - Price: $4.99/month, recurring
   - Copy the **Price ID** (starts with `price_`) → that's your `STRIPE_PRICE_ID`

3. **Create a Webhook:**
   - Developers → Webhooks → Add endpoint
   - URL: `https://your-app-name.railway.app/webhook`
   - Events to listen for: `customer.subscription.deleted`, `invoice.payment_failed`
   - Copy the **Signing Secret** (starts with `whsec_`) → that's your `STRIPE_WEBHOOK_SECRET`

---

## Building the Windows installer

Inside the `pixel-app` folder:

```bash
npm install --save-dev electron-builder
npx electron-builder --win
```

The installer appears in `dist/Rosie Setup.exe` — that's the file you distribute.

---

## How it all works

```
User asks question
       ↓
Electron app → POST /ask (with deviceId)
       ↓
Server checks: free questions used? paid?
       ↓
If allowed → asks Claude → returns answer
If limit hit → returns free_limit_reached error
       ↓
App shows paywall → user clicks Subscribe
       ↓
Server creates Stripe checkout → opens in browser
       ↓
User pays → Stripe webhook fires → server marks user as paid
       ↓
App polls /status every 5s → sees isPaid=true → unlocks
```

---

## Files

```
rosie-server/
├── server.js      ← main server (Express + Stripe + Claude)
├── .env.example   ← copy to .env and fill in your keys
├── .gitignore
├── package.json
└── data.json      ← auto-created, stores user records
```
