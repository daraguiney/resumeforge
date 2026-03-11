import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent'

const adminSupabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

const ALLOWED_ORIGINS = [
  'https://resumeforge.com',
  'https://www.resumeforge.com',
  'https://resumeforge-delta.vercel.app',
  'http://localhost',
  'http://127.0.0.1',
]
const DEFAULT_ORIGIN = 'https://resumeforge-delta.vercel.app'

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || ''
  const allowed = ALLOWED_ORIGINS.some((o) => origin.startsWith(o)) ? origin : DEFAULT_ORIGIN
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
}

function buildPrompt(feature: string, data: Record<string, unknown>): string | null {
  if (feature === 'summary') {
    const { name, title, skills, experience } = data as {
      name: string; title: string; skills: string; experience: {title:string;company:string}[]
    }
    const expText = (experience || []).map(e => `${e.title} at ${e.company}`).join(', ')
    return `Write a 2-3 sentence professional resume summary for a ${title} named ${name}.
Experience: ${expText || 'N/A'}
Skills: ${skills || 'N/A'}
Rules: No first-person pronouns. Focus on measurable impact and value. Return only the summary text.`
  }

  if (feature === 'bullets') {
    const { experience } = data as { experience: {title:string;company:string}[] }
    const roles = (experience || []).map(e => `${e.title} at ${e.company}`).join('\n')
    return `Write 3-4 strong resume bullet points for each role below. Use action verbs and include metrics.

Roles:
${roles}

Format: one group per role separated by --- on its own line. Each bullet starts with •
Example:
• Led team of 8 engineers to ship feature reducing churn by 22%
• Owned roadmap for 3 product lines generating $4M ARR
---
• Built MVP in 4 weeks, onboarding 300 beta users

Return only the bullet groups in this format, nothing else.`
  }

  if (feature === 'coverletter') {
    const { name, role, company, manager, summary, experience } = data as {
      name: string; role: string; company: string; manager: string;
      summary: string; experience: {title:string;company:string}[]
    }
    const expText = (experience || []).slice(0, 3).map(e => `${e.title} at ${e.company}`).join(', ')
    return `Write a professional cover letter for ${name} applying for the ${role} position at ${company}.
Addressed to: ${manager || 'Hiring Team'}
Their background: ${summary || 'Experienced professional'}
Recent experience: ${expText || 'N/A'}

Write exactly 3 paragraphs: strong opening, relevant value/experience, confident closing.
Start with "Dear ${manager || 'Hiring Team'}," and end with "Warm regards,\n${name}"
Return only the letter text.`
  }

  return null
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)

    const userSupabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: userError } = await userSupabase.auth.getUser()
    if (userError || !user) return json({ error: 'Invalid session' }, 401)

    const { data: profile } = await adminSupabase
      .from('profiles')
      .select('is_pro')
      .eq('id', user.id)
      .single()

    if (!profile?.is_pro) return json({ error: 'Pro subscription required' }, 403)

    const { feature, data } = await req.json()
    const prompt = buildPrompt(feature, data || {})
    if (!prompt) return json({ error: 'Unknown feature' }, 400)

    const geminiKey = Deno.env.get('GEMINI_API_KEY')
    if (!geminiKey) return json({ error: 'AI service not configured' }, 500)

    const geminiRes = await fetch(`${GEMINI_URL}?key=${geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
      }),
    })

    if (!geminiRes.ok) {
      const err = await geminiRes.text()
      console.error('Gemini error:', err)
      return json({ error: 'AI generation failed' }, 500)
    }

    const geminiData = await geminiRes.json()
    const text: string = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || ''

    return json({ text })
  } catch (err) {
    console.error('ai-assist error:', err)
    return json({ error: 'Internal server error' }, 500)
  }
})
