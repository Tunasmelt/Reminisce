import { NextResponse } from 'next/server'
import { supabase as clientSupabase, isUserBanned } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// PX-1: cap proxied response at 5 MB to prevent OOM in Vercel function
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await clientSupabase.auth.getUser(token)
    if (!user || authError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // PX-2: banned check
    if (await isUserBanned(user.id))
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

    // PX-3: guard JSON parse so bad body returns 400 not 500
    let body: { url?: string; method?: string; headers?: Record<string, string>; body?: string; authType?: string; authValue?: string }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const { url, method, headers, body: reqBody, authType, authValue } = body

    if (!url || !method) {
      return NextResponse.json({ error: 'Missing URL or Method' }, { status: 400 })
    }

    // R-4: whitelist safe HTTP methods — block CONNECT, TRACE, and other
    // dangerous verbs that could be used for protocol-level abuse
    const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
    if (!ALLOWED_METHODS.has(String(method).toUpperCase())) {
      return NextResponse.json(
        { error: `Method "${method}" is not allowed. Use: ${Array.from(ALLOWED_METHODS).join(', ')}` },
        { status: 400 },
      )
    }
    const safeMethod = String(method).toUpperCase()

    // ── SSRF protection ─────────────────────────────────────────────────────
    // Block private/internal network addresses and non-HTTPS schemes
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return NextResponse.json({ error: 'Only HTTP/HTTPS URLs are allowed' }, { status: 400 })
    }

    const hostname = parsedUrl.hostname.toLowerCase()
    const blockedPatterns = [
      /^localhost$/,
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^169\.254\./,  // link-local / AWS metadata service
      /^::1$/,        // IPv6 loopback
      /^0\.0\.0\.0$/,
      /\.internal$/,
      /\.local$/,
      // PX-4: IPv6-mapped IPv4 addresses (e.g. ::ffff:127.0.0.1) bypass the
      // IPv4 checks above because the hostname looks like an IPv6 address.
      // Block the ::ffff: prefix in all its representations.
      /^::ffff:/i,
      /^0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}:ffff:/i,
      /^\[::ffff:/i,  // bracket-quoted form some clients emit
      // PX-7: Alternative IPv4 encodings that bypass the dotted-decimal
      // patterns above — all resolve to the same (often internal) addresses:
      //   decimal integer  http://2130706433        → 127.0.0.1
      //   hex              http://0x7f000001         → 127.0.0.1
      //   octal/hex octets http://0177.0.0.1, 0x7f.. → 127.0.0.1
      /^\d+$/,             // bare decimal integer host
      /(^|\.)0x[0-9a-f]+/i, // hex octet (or whole-host hex)
      /(^|\.)0\d+/,        // octal octet (leading-zero numeric label)
    ]
    if (blockedPatterns.some(p => p.test(hostname))) {
      return NextResponse.json({ error: 'Private/internal URLs are not allowed' }, { status: 400 })
    }

    const fetchHeaders: Record<string, string> = { ...(headers ?? {}) }

    if (authType === 'Bearer Token' && authValue) {
      fetchHeaders['Authorization'] = `Bearer ${authValue}`
    } else if (authType === 'API Key' && authValue) {
      fetchHeaders['x-api-key'] = authValue
    }

    const start = Date.now()
    let ttfb = 0

    try {
      // PX-5: Disable redirect following. A target server returning 301/302 to
      // an internal address (e.g. http://169.254.169.254/) would bypass the
      // SSRF blocklist above because the check only runs on the original URL.
      // With redirect:'error', fetch throws on any redirect and we return a
      // clean error to the client instead of following the redirect chain.
      const response = await fetch(url, {
        method: safeMethod,
        headers: fetchHeaders,
        body: safeMethod !== 'GET' && safeMethod !== 'HEAD' ? reqBody : undefined,
        redirect: 'error',
      })

      ttfb = Date.now() - start

      // PX-1: stream the response and abort if it exceeds the size cap
      // to prevent OOM from large proxied responses buffered in memory
      const reader = response.body?.getReader()
      let responseText = ''
      if (reader) {
        const decoder = new TextDecoder()
        let bytesRead = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          bytesRead += value.byteLength
          if (bytesRead > MAX_RESPONSE_BYTES) {
            reader.cancel()
            return NextResponse.json(
              { error: `Response exceeds the ${MAX_RESPONSE_BYTES / 1024 / 1024} MB size limit` },
              { status: 413 },
            )
          }
          responseText += decoder.decode(value, { stream: true })
        }
      } else {
        responseText = await response.text()
      }

      const totalTime = Date.now() - start

      // PX-6: Only forward a safe subset of response headers back to the client.
      // Forwarding all headers (e.g. Set-Cookie, Authorization, WWW-Authenticate,
      // Strict-Transport-Security) leaks session tokens and security policy from
      // third-party servers into the user's browser context.
      const SAFE_RESPONSE_HEADERS = new Set([
        'content-type',
        'content-length',
        'content-encoding',
        'cache-control',
        'etag',
        'last-modified',
        'x-request-id',
        'x-ratelimit-limit',
        'x-ratelimit-remaining',
        'x-ratelimit-reset',
        'retry-after',
        'date',
        'server',
      ])
      const safeHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        if (SAFE_RESPONSE_HEADERS.has(key.toLowerCase())) {
          safeHeaders[key.toLowerCase()] = value
        }
      })

      return NextResponse.json({
        status: response.status,
        statusText: response.statusText,
        headers: safeHeaders,
        body: responseText,
        timing: {
          total: totalTime,
          ttfb: ttfb
        },
        size: responseText.length
      })
    } catch (fetchErr: unknown) {
      return NextResponse.json({ 
        error: fetchErr instanceof Error ? fetchErr.message : 'Network failure',
        status: 0,
        timing: { total: Date.now() - start, ttfb: 0 }
      }, { status: 500 })
    }

  } catch (error: unknown) {
    console.error('[proxy] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
