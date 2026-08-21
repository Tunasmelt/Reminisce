import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  // Admin route protection is handled by app/admin/layout.tsx
  // which verifies session + is_admin flag via the API.
  // No middleware cookie check needed — Supabase JS v2 cookie names
  // vary by project ref and cannot be reliably checked at edge.
  return NextResponse.next()
}

export const config = {
  matcher: ['/admin/:path*'],
}
