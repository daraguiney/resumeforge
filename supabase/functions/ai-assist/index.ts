import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = 'llama-3.3-70b-versatile'

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

  if (feature === 'parse') {
    const { text } = data as { text: string }
    return `Parse this resume text and extract structured information. Return ONLY valid JSON with no markdown, no code blocks, no explanation — just the raw JSON object.

Required JSON structure:
{
  "name": "full name",
  "title": "most recent job title",
  "email": "email address",
  "phone": "phone number",
  "location": "city, state or country",
  "link": "linkedin URL or portfolio URL",
  "summary": "professional summary if present (2-3 sentences max)",
  "skills": "comma-separated skills list",
  "experience": [
    {"title": "job title", "company": "company name", "dates": "date range e.g. Jan 2020 – Present", "bullets": "achievement 1\\nachievement 2\\nachievement 3"}
  ],
  "education": [
    {"title": "degree name", "company": "institution name", "dates": "graduation year or range"}
  ]
}

Use empty string "" for any field not found. For experience bullets, separate each point with \\n (newline).

Resume text:
${(text || '').slice(0, 4000)}`
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

    const body = await req.json().catch(() => ({}))
    const { feature, data } = body

    // 'parse' is free for all logged-in users; other AI features require Pro
    if (feature !== 'parse') {
      const { data: profile } = await adminSupabase
        .from('profiles')
        .select('is_pro')
        .eq('id', user.id)
        .single()

      if (!profile?.is_pro) return json({ error: 'Pro subscription required' }, 403)
    }
    console.log('ai-assist feature:', feature, 'user:', user.id)

    const prompt = buildPrompt(feature, data || {})
    if (!prompt) return json({ error: 'Unknown feature: ' + feature }, 400)

    const groqKey = Deno.env.get('GROQ_API_KEY')
    if (!groqKey) {
      console.error('GROQ_API_KEY not set')
      return json({ error: 'AI service not configured' }, 500)
    }

    const groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 1024,
      }),
    })

    if (!groqRes.ok) {
      const errText = await groqRes.text()
      console.error('Groq HTTP error', groqRes.status, errText)
      return json({ error: 'AI error ' + groqRes.status + ': ' + errText.slice(0, 200) }, 500)
    }

    const groqData = await groqRes.json()
    console.log('Groq finish reason:', groqData?.choices?.[0]?.finish_reason)
    const text: string = groqData?.choices?.[0]?.message?.content || ''

    return json({ text })
  } catch (err) {
    console.error('ai-assist error:', err)
    return json({ error: 'Internal server error' }, 500)
  }
})
