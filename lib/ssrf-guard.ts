import { promises as dnsPromises, type LookupAddress } from 'node:dns'
import type { LookupFunction } from 'node:net'
import { Agent } from 'undici'

// ─────────────────────────────────────────────────────────────────────────────
//  SSRF guard — the single source of truth for "is this host private/internal?"
//  plus the DNS-rebinding defence used by /api/proxy.
//
//  Two layers:
//   1. isBlockedHost(value)   — string check, works on BOTH a raw hostname AND a
//      resolved IP. Covers loopback/RFC-1918/link-local/cloud-metadata, the
//      alternative IPv4 encodings (decimal/hex/octal), IPv6-mapped IPv4, and
//      resolved-side IPv6 ULA (fc00::/7) + link-local (fe80::/10).
//   2. resolveAndValidateHost + createPinnedAgent — resolve the hostname, reject
//      if ANY resolved address is blocked, then pin the TCP connection to a
//      validated IP so a rebind between check and fetch can't reach an internal
//      target.
//
//  Kept as free functions (no route/request state) so a table-driven test suite
//  can import and exercise every notation directly.
// ─────────────────────────────────────────────────────────────────────────────

// Single source of truth. Both the route's original hostname check and the
// resolved-IP check below run against this exact list.
const BLOCKED_PATTERNS: RegExp[] = [
  /^localhost$/,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,                                   // link-local / cloud metadata (169.254.169.254)
  /^::1$/,                                          // IPv6 loopback
  /^0\.0\.0\.0$/,
  /\.internal$/,
  /\.local$/,
  // IPv6-mapped IPv4 (e.g. ::ffff:127.0.0.1) — bypasses the IPv4 checks because
  // the host looks like an IPv6 address.
  /^::ffff:/i,
  /^0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}:ffff:/i,
  /^\[::ffff:/i,
  // Alternative IPv4 encodings that all resolve to the same (often internal)
  // addresses: decimal (2130706433), hex (0x7f000001), octal/hex octets.
  /^\d+$/,
  /(^|\.)0x[0-9a-f]+/i,
  /(^|\.)0\d+/,
  // Resolved-side IPv6 the literal-string forms above miss (bracket-tolerant so
  // a directly-typed literal is caught too):
  /^\[?f[cd][0-9a-f]{2}:/i,                         // ULA  fc00::/7  (first hextet fc00–fdff)
  /^\[?fe[89ab][0-9a-f]:/i,                         // link-local fe80::/10 (fe80–febf)
]

/** True if `value` (a hostname OR a resolved IP string) is private/internal. */
export function isBlockedHost(value: string): boolean {
  const v = value.toLowerCase()
  return BLOCKED_PATTERNS.some(p => p.test(v))
}

export type HostValidation =
  | { ok: true; pinnedIp: string; family: number }
  | { ok: false; reason: string }

/**
 * Resolve `hostname` to every A/AAAA record and validate each against
 * isBlockedHost. Fail-closed: if ANY resolved address is blocked (or resolution
 * fails / returns nothing) the whole host is rejected. On success returns the
 * first resolved address to pin the connection to.
 */
export async function resolveAndValidateHost(hostname: string): Promise<HostValidation> {
  const lookupHost = hostname.replace(/^\[|\]$/g, '') // strip IPv6 literal brackets for dns.lookup
  let records: LookupAddress[]
  try {
    records = await dnsPromises.lookup(lookupHost, { all: true, verbatim: true })
  } catch {
    return { ok: false, reason: 'DNS resolution failed' }
  }
  if (records.length === 0) {
    return { ok: false, reason: 'Host did not resolve' }
  }
  for (const rec of records) {
    if (isBlockedHost(rec.address)) {
      return { ok: false, reason: 'Host resolves to a private/internal address' }
    }
  }
  return { ok: true, pinnedIp: records[0].address, family: records[0].family }
}

/**
 * Build a single-use undici Agent whose connector always resolves to `pinnedIp`,
 * ignoring DNS entirely — so the actual TCP target is the exact address we
 * validated, closing the rebind window. TLS servername/SNI is NOT overridden, so
 * undici keeps it as the original request hostname → certificate validation
 * still targets the real host and HTTPS to normal public sites works.
 */
export function createPinnedAgent(pinnedIp: string, family: number): Agent {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options && (options as { all?: boolean }).all) {
      callback(null, [{ address: pinnedIp, family }])
    } else {
      callback(null, pinnedIp, family)
    }
  }
  return new Agent({ connect: { lookup } })
}
