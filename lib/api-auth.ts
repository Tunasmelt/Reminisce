import { NextResponse } from 'next/server'
import { supabase as clientSupabase } from '@/lib/supabase'
import type { User } from '@supabase/supabase-js'

type AuthSuccess = { user: User; errorResponse: null }
type AuthFailure = { user: null; errorResponse: NextResponse }

/**
 * Validates the Bearer token from the request's Authorization header.
 *
 * Returns `{ user, errorResponse: null }` on success so the caller has the
 * authenticated user immediately available.
 *
 * Returns `{ user: null, errorResponse }` on failure — the caller should
 * `return errorResponse` directly.
 *
 * Usage (replaces 5 lines of boilerplate in every route):
 *
 *   const { user, errorResponse } = await authenticateRequest(req)
 *   if (errorResponse) return errorResponse
 *   // `user` is guaranteed non-null below this line
 *
 * Auth-11: Centralises the auth pattern so any future changes (e.g. switching
 * to cookie-based sessions, adding IP checks) happen in one place.
 */
export async function authenticateRequest(
  req: Request,
): Promise<AuthSuccess | AuthFailure> {
  const authHeader = req.headers.get('authorization')
  if (!authHeader) {
    return {
      user: null,
      errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }

  const token = authHeader.replace('Bearer ', '')
  const {
    data: { user },
    error: authError,
  } = await clientSupabase.auth.getUser(token)

  if (!user || authError) {
    return {
      user: null,
      errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }

  return { user, errorResponse: null }
}
