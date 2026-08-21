'use client'

import { useAuthStore } from '@/store/auth'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, initialized } = useAuthStore()
  const router = useRouter()

  useEffect(() => {
    if (initialized && !user) {
      // AU-4: Preserve the user's intended destination so login can redirect
      // back to it after authentication. Without this, deep-linked URLs
      // (e.g. /dashboard/projects/abc/agent) are silently lost and the user
      // lands at /dashboard after login.
      const destination = window.location.pathname + window.location.search
      router.push('/login?redirect=' + encodeURIComponent(destination))
    }
  }, [user, initialized, router])

  // Show spinner only while session is being resolved.
  // Once initialized and user is absent, the effect above fires the redirect —
  // return null for that single frame rather than flashing the spinner.
  if (!initialized) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#0a0a0e]">
        <div className="w-8 h-8 md:w-12 md:h-12 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></div>
      </div>
    )
  }

  if (!user) return null

  return <>{children}</>
}
