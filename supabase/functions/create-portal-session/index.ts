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

// Restrict to known origins — never use wildcard on authenticated endpoints
const ALLOWED_ORIGINS = [
  'https://resumeforge.com',
  'https://www.resumeforge.com',
  'http://localhost',
  'http://127.0.0.1',
]

const DEFAULT_ORIGIN = 'https://resumeforge.com'

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || ''
  const allowed = ALLOWED_ORIGINS.some((o) => origin.startsWith(o)) ? origin : DEFAULT_ORIGIN
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
}

function sanitizeReturnUrl(raw: string | null): string {
  if (!raw) return DEFAULT_ORIGIN
  try {
    const u = new URL(raw)
    const isAllowed = ALLOWED_ORIGINS.some((o) => (u.origin + '/').startsWith(o.endsWith('/') ? o : o + '/'))
    return isAllowed ? u.origin + u.pathname : DEFAULT_ORIGIN
  } catch {
    return DEFAULT_ORIGIN
  }
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const token = authHeader.replace('Bearer ', '')

    // Verify the JWT and get the user
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Get stripe_customer_id from profiles
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single()

    if (profileError || !profile?.stripe_customer_id) {
      return new Response(
        JSON.stringify({ error: 'No active subscription found for this account.' }),
        {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    const body = await req.json().catch(() => ({}))
    // Validate returnUrl to prevent open redirect
    const returnUrl = sanitizeReturnUrl(body.returnUrl || req.headers.get('origin'))

    // Create Stripe Customer Portal session using the configured portal
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      configuration: 'bpc_1T9puCCKzWnyU2tPS9a409mj',
      return_url: returnUrl,
    })

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('Portal session error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
