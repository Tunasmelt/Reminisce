import { NextResponse } from 'next/server'
import { supabase as clientSupabase, isUserBanned } from '@/lib/supabase'
import { isBlockedHost, resolveAndValidateHost, createPinnedAgent } from '@/lib/ssrf-guard'
// Use undici's OWN fetch (not Node's global fetch): a dispatcher from the undici
// package is only accepted by that same package's fetch — Node's global fetch,
// backed by its bundled undici, rejects it with UND_ERR_INVALID_ARG.
import { fetch, type Agent } from 'undici'

export const dynamic = 'force-dynamic'

// PX-1: cap proxied response at 5 MB to prevent OOM in Vercel function
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

export async function POST(req: Request) {
  // Single-use, DNS-pinned dispatcher (Fix 4). Declared here so the finally
  // below can close it regardless of which return/throw path is taken.
  let pinnedAgent: Agent | undefined
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

    // Layer 1 — string check on the hostname text. The full pattern list now
    // lives in lib/ssrf-guard as the single source of truth (shared with the
    // resolved-IP check below): loopback/RFC-1918/link-local/cloud-metadata,
    // IPv6-mapped IPv4, and the alternative IPv4 encodings (decimal/hex/octal).
    if (isBlockedHost(hostname)) {
      return NextResponse.json({ error: 'Private/internal URLs are not allowed' }, { status: 400 })
    }

    // Layer 2 (Fix 4) — DNS-rebinding guard. The string check only inspects the
    // hostname text; a public name that resolves to a private IP (127.0.0.1,
    // 169.254.169.254, …) would still pass it. Resolve the host, reject if ANY
    // resolved address is private, then pin the connection to a validated IP via
    // an undici dispatcher so the actual TCP target can't differ from what we
    // checked (closes the check-then-rebind window).
    const validation = await resolveAndValidateHost(hostname)
    if (!validation.ok) {
      return NextResponse.json({ error: 'Private/internal URLs are not allowed' }, { status: 400 })
    }
    pinnedAgent = createPinnedAgent(validation.pinnedIp, validation.family)

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
      // dispatcher pins the TCP connection to the validated IP (Fix 4).
      // Everything below the fetch (streaming, 5 MB cap, SAFE_RESPONSE_HEADERS)
      // is unchanged — undici's Response is WHATWG-compatible.
      const response = await fetch(url, {
        method: safeMethod,
        headers: fetchHeaders,
        body: safeMethod !== 'GET' && safeMethod !== 'HEAD' ? reqBody : undefined,
        redirect: 'error',
        dispatcher: pinnedAgent,
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
  } finally {
    // Close the single-use pinned Agent so its keep-alive socket doesn't linger
    // after the response has been fully read. Best-effort — never mask the result.
    if (pinnedAgent) { try { await pinnedAgent.close() } catch { /* ignore */ } }
  }
}
