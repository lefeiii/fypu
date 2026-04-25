/**
 * Vercel Serverless Function — Anthropic API Proxy
 * Runtime: Node.js (NOT edge — edge ignores maxDuration and has 25s hard limit)
 * maxDuration: 60 is set in vercel.json
 */

const RATE_LIMIT_WINDOW_MS = 60_000
const MAX_REQUESTS_PER_WINDOW = 10
const rateLimitMap = new Map()

function isRateLimited(ip) {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now })
    return false
  }
  if (entry.count >= MAX_REQUESTS_PER_WINDOW) return true
  entry.count++
  return false
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const ip = req.headers['x-forwarded-for'] ?? 'unknown'
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' })

  try {
    const body = req.body
    if (!body.model || !body.messages || !Array.isArray(body.messages)) {
      return res.status(400).json({ error: 'Invalid request body' })
    }

    const safeBody = {
      ...body,
      max_tokens: Math.min(body.max_tokens ?? 1000, 8000),
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(safeBody),
    })

    const data = await anthropicRes.json()
    return res.status(anthropicRes.status).json(data)

  } catch (err) {
    console.error('Proxy error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
