'use client'

import { useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/store/auth'

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { setUser, setInitialized } = useAuthStore()

  useEffect(() => {
    supabase.auth.getSession()
      .then(({ data: { session } }) => {
        setUser(session?.user ?? null, session)
        setInitialized(true)
      })
      // AU-3: If getSession() rejects (network error on cold load), the app
      // would otherwise freeze at the loading spinner forever because
      // setInitialized(true) is never called. Treat it as signed-out.
      .catch(() => {
        setUser(null, null)
        setInitialized(true)
      })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null, session)
    })

    return () => subscription.unsubscribe()
  }, [setUser, setInitialized])

  return <>{children}</>
}
