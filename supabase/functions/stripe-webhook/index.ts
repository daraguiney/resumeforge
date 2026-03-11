import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@14'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2023-10-16',
})

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

serve(async (req) => {
  const signature = req.headers.get('stripe-signature')
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')

  if (!signature || !webhookSecret) {
    return new Response('Missing signature or webhook secret', { status: 400 })
  }

  let event: Stripe.Event

  try {
    const body = await req.text()
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret)
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message)
    return new Response(`Webhook Error: ${err.message}`, { status: 400 })
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        const userId = session.client_reference_id

        if (!userId) {
          console.error('No client_reference_id on session:', session.id)
          return new Response('No client_reference_id', { status: 200 })
        }

        // customer is string | Customer | DeletedCustomer | null — extract safely
        const stripeCustomerId = typeof session.customer === 'string'
          ? session.customer
          : (session.customer as Stripe.Customer | null)?.id ?? null

        if (!stripeCustomerId) {
          console.error('No customer ID on completed session:', session.id)
          return new Response('No customer ID', { status: 200 })
        }

        const { error } = await supabase
          .from('profiles')
          .upsert(
            { id: userId, is_pro: true, stripe_customer_id: stripeCustomerId },
            { onConflict: 'id' }
          )

        if (error) {
          console.error('Supabase upsert error:', JSON.stringify(error))
          return new Response(`DB error: ${error.message}`, { status: 500 })
        }

        console.log(`Activated pro for user ${userId}, customer: ${stripeCustomerId}`)
        break
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription

        // Look up the user by stripe_customer_id (metadata approach is unreliable
        // because nothing in the checkout flow populates supabase_user_id on the subscription)
        const stripeCustomerId = typeof subscription.customer === 'string'
          ? subscription.customer
          : (subscription.customer as Stripe.Customer | null)?.id ?? null

        if (!stripeCustomerId) {
          console.warn('No customer ID on subscription deletion:', subscription.id)
          break
        }

        const { error } = await supabase
          .from('profiles')
          .update({ is_pro: false })
          .eq('stripe_customer_id', stripeCustomerId)

        if (error) {
          console.error('Supabase update error:', error)
          return new Response('DB error', { status: 500 })
        }

        console.log(`Deactivated pro for stripe customer ${stripeCustomerId}`)
        break
      }

      default:
        console.log(`Unhandled event type: ${event.type}`)
    }
  } catch (err) {
    console.error('Handler error:', err)
    return new Response('Internal error', { status: 500 })
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
