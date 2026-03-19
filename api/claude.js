/**
 * Vercel Edge Function — Anthropic API Proxy
 * 
 * This file lives at /api/claude.js and acts as a secure server-side
 * proxy so the Anthropic API key is NEVER exposed to the browser.
 * 
 * All requests from the frontend go to /api/claude → this function
 * → Anthropic API → response back to frontend.
 */

export const config = {
  runtime: 'edge',
}

// Simple in-memory rate limiter (resets per edge instance)
// For production, use Vercel KV or Upstash Redis for persistent rate limiting
const rateLimitMap = new Map()
const RATE_LIMIT_WINDOW_MS = 60_000  // 1 minute
const MAX_REQUESTS_PER_WINDOW = 10   // 10 AI calls per minute per IP

function isRateLimited(ip) {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)
  
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now })
    return false
  }
  
  if (entry.count >= MAX_REQUESTS_PER_WINDOW) {
    return true
  }
  
  entry.count++
  return false
}

export default async function handler(req) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // Rate limiting by IP
  const ip = req.headers.get('x-forwarded-for') ?? 'unknown'
  if (isRateLimited(ip)) {
    return new Response(JSON.stringify({ 
      error: 'Too many requests. Please wait a moment before trying again.' 
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // Get API key from environment variable (set in Vercel dashboard)
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'API key not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  try {
    const body = await req.json()

    // Validate the request body has required fields
    if (!body.model || !body.messages || !Array.isArray(body.messages)) {
      return new Response(JSON.stringify({ error: 'Invalid request body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // Hard cap on max_tokens to prevent runaway costs
    const safeBody = {
      ...body,
      max_tokens: Math.min(body.max_tokens ?? 1000, 4000),
    }

    // Forward to Anthropic
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

    return new Response(JSON.stringify(data), {
      status: anthropicRes.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    })

  } catch (err) {
    console.error('Proxy error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}
