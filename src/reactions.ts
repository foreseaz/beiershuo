import { useState } from 'react'

/**
 * One-tap reactions (on a segment while it plays, or on a sub-topic card) are counted anonymously in PostHog as named
 * events (README · 统计). The device remembers what it has already sent, so a second tap does not count twice.
 */

const GIVEN = 'beiershuo.feedback'
/** Enough to remember every reaction someone is likely to give; the oldest are forgotten first. */
const GIVEN_LIMIT = 500

function readGiven(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(GIVEN) ?? '[]')
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** The reactions this device has sent, by id, and a way to record a new one. */
export function useGiven() {
  const [given, setGiven] = useState(() => new Set(readGiven()))
  const give = (id: string) => {
    const next = [...readGiven().filter(item => item !== id), id].slice(-GIVEN_LIMIT)
    try { window.localStorage.setItem(GIVEN, JSON.stringify(next)) } catch { /* counted once per visit instead */ }
    setGiven(new Set([...given, ...next]))
  }
  return [given, give] as const
}
