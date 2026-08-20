import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Convert a CSS hex colour to an rgba() string.
 * Falls back to amber (245,158,11) when hex is missing or malformed.
 *
 * Previously defined inline in 4+ files — centralised here so there is one
 * canonical implementation (U-1).
 */
export function hexToRgba(hex: string, alpha: number): string {
  if (!hex || hex.length < 7) return `rgba(245,158,11,${alpha})`
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}
