'use client'

import { useState, useEffect } from 'react'
import { useTheme } from '@/hooks/useTheme'
import ThemeOnboarding from './ThemeOnboarding'

export default function OnboardingGate({ 
  children 
}: { 
  children: React.ReactNode 
}) {
  const { hasChosen } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])
  
  // AU-12: Before mount we don't yet know whether to show ThemeOnboarding or
  // children — but we must not render children hidden because that runs the
  // full React tree (all useEffect hooks, data-fetching calls, etc.) during an
  // invisible phase, effectively doubling every API call on first load.
  // Rendering an empty black placeholder instead avoids that cost and is still
  // invisible to the user — same visual result, zero wasted work.
  if (!mounted) {
    return <div style={{ minHeight: '100vh', background: '#000' }} />
  }

  if (!hasChosen) {
    return <ThemeOnboarding />
  }

  return <>{children}</>
}
