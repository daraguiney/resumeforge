# Stripe → Supabase Webhook Setup

## Step 1 — Run the SQL migration in Supabase

1. Go to https://supabase.com/dashboard/project/nwnxhnwnffqzccwrbklv/sql
2. Paste the contents of `supabase/migrations/20260310_create_profiles.sql`
3. Click **Run**

This creates the `profiles` table with `is_pro` and auto-creates a profile row for every new signup.

---

## Step 2 — Deploy the Edge Function

Install the Supabase CLI first:
```bash
brew install supabase/tap/supabase
```

Then link and deploy:
```bash
supabase login
supabase link --project-ref nwnxhnwnffqzccwrbklv
supabase functions deploy stripe-webhook
```

---

## Step 3 — Set environment secrets

```bash
supabase secrets set STRIPE_SECRET_KEY=sk_test_YOUR_KEY_HERE
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_YOUR_SECRET_HERE
```

Get these from:
- `STRIPE_SECRET_KEY` → https://dashboard.stripe.com/test/apikeys
- `STRIPE_WEBHOOK_SECRET` → next step below

---

## Step 4 — Register the webhook in Stripe

1. Go to https://dashboard.stripe.com/test/webhooks
2. Click **Add endpoint**
3. URL: `https://nwnxhnwnffqzccwrbklv.supabase.co/functions/v1/stripe-webhook`
4. Events to listen for:
   - `checkout.session.completed`
   - `customer.subscription.deleted`
5. Click **Add endpoint**
6. Copy the **Signing secret** (starts with `whsec_`)
7. Run: `supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_YOUR_SECRET`

---

## Step 5 — Test it

1. Open your site and sign in
2. Click a pricing button — it now appends `?client_reference_id=YOUR_USER_ID` to the Stripe URL
3. Complete a test payment (use card `4242 4242 4242 4242`, any future date, any CVC)
4. Check Stripe Dashboard → Webhooks → your endpoint → see the event delivered
5. Check Supabase → Table Editor → profiles → `is_pro` should be `true`

---

## How it works

```
User clicks pay
  → openStripeCheckout() appends ?client_reference_id=USER_ID to URL
  → User completes Stripe checkout
  → Stripe fires checkout.session.completed webhook
  → Edge Function receives it, verifies signature
  → Reads client_reference_id (= Supabase user ID)
  → Upserts profiles row: is_pro = true
  → Next time user loads the site, Supabase returns is_pro = true
  → Pro features unlock instantly
```
