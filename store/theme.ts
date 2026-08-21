import { create } from 'zustand'

interface ThemeStore {
  theme: string
  hasChosen: boolean
  setTheme: (theme: string) => void
  setHasChosen: (val: boolean) => void
}

export const useThemeStore = create<ThemeStore>((set) => {
  // Sync initialization on client side
  let initialTheme = 'solar-flare'
  let initialHasChosen = false
  
  if (typeof window !== 'undefined') {
    // AU-5: Wrap ALL localStorage access in try/catch.
    // In Safari private browsing, localStorage.getItem() throws a SecurityError
    // and localStorage.setItem() throws a QuotaExceededError. Since this is
    // module-level initializer code, an uncaught exception would crash the
    // entire app before React even mounts. Fall back to defaults on any error.
    try {
      initialTheme = document.documentElement.getAttribute('data-theme') ||
                     localStorage.getItem('reminisce-theme') ||
                     'solar-flare'

      // If theme was already set (blocking script ran), consider user as having chosen
      const storedChoice = localStorage.getItem('reminisce-theme-chosen')
      const storedTheme  = localStorage.getItem('reminisce-theme')
      initialHasChosen = storedChoice === 'true'
        || (storedTheme !== null && storedTheme !== '')
    } catch {
      // Private browsing / storage blocked — use defaults (solar-flare, not chosen)
    }
  }

  return {
    theme: initialTheme,
    hasChosen: initialHasChosen,
    setTheme: (theme: string) => {
      if (typeof window !== 'undefined') {
        document.documentElement.setAttribute('data-theme', theme)
        // AU-6: setItem throws QuotaExceededError in Safari private mode.
        // Apply the theme in-memory regardless — persisting is best-effort.
        try { localStorage.setItem('reminisce-theme', theme) } catch { /* non-fatal */ }
      }
      set({ theme })
    },
    setHasChosen: (val: boolean) => {
      if (typeof window !== 'undefined') {
        try { localStorage.setItem('reminisce-theme-chosen', val ? 'true' : 'false') } catch { /* non-fatal */ }
      }
      set({ hasChosen: val })
    }
  }
})
