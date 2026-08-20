'use client'

import { useEffect } from 'react'

/**
 * Next.js App Router error boundary for the top-level dashboard pages
 * (/dashboard and /dashboard/templates and /dashboard/import).
 * Project sub-page errors are caught by the deeper error.tsx in [id]/.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[dashboard] render error:', error)
  }, [error])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '70vh',
        padding: '40px 24px',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          width: 52,
          height: 52,
          borderRadius: 14,
          background: 'rgba(239,68,68,0.1)',
          border: '1px solid rgba(239,68,68,0.22)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 22,
          marginBottom: 20,
        }}
      >
        ⚠️
      </div>

      <h2
        style={{
          color: '#fff',
          fontSize: 18,
          fontWeight: 700,
          margin: '0 0 8px',
        }}
      >
        Something went wrong
      </h2>

      <p
        style={{
          color: 'rgba(255,255,255,0.45)',
          fontSize: 14,
          marginBottom: 24,
          maxWidth: 360,
          lineHeight: 1.6,
        }}
      >
        The dashboard encountered an unexpected error. Try reloading or go back
        to the home page.
      </p>

      <div style={{ display: 'flex', gap: 10 }}>
        <button
          onClick={reset}
          style={{
            padding: '10px 20px',
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.15)',
            background: 'rgba(255,255,255,0.08)',
            color: '#fff',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Try again
        </button>
        <a
          href="/dashboard"
          style={{
            padding: '10px 20px',
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.08)',
            background: 'transparent',
            color: 'rgba(255,255,255,0.45)',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
            textDecoration: 'none',
          }}
        >
          Dashboard home
        </a>
      </div>
    </div>
  )
}
