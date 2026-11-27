import { useState } from 'react'

/**
 * Feedback for 贝儿, in two weights:
 *
 * - Letters: written words, kept in D1 by the Worker (worker/index.ts) and read in the Cloudflare dashboard. They never
 *   go to PostHog.
 * - One-tap reactions (on a segment while it plays, or on a sub-topic card): counted in PostHog as named events. The
 *   device remembers what it has already sent, so a second tap does not count twice.
 */

/** Keep in step with LIMITS in worker/index.ts. */
export const LETTER_LIMITS = { body: 1000, name: 40, contact: 100 }

export type Letter = { body: string; name: string; contact: string; about: string; page: string; website: string }
/** What the letter answers, when it was started from a segment: shown in the dialog and stored with the letter. */
export type LetterAbout = { label: string; page: string }

const ERRORS: Record<string, string> = {
  empty: '先写点什么吧。',
  too_long: `太长了，请控制在 ${LETTER_LIMITS.body} 字以内。`,
  link: '留言里不能放链接。',
  busy: '寄得有点快，过一分钟再寄吧。',
  full: '今天的信箱满了，明天再来吧。',
}

/** Sends a letter; resolves to an error to show, or null once it is stored. */
export async function sendLetter(letter: Letter): Promise<string | null> {
  try {
    const response = await fetch('/api/letters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(letter),
    })
    if (response.ok) return null
    const { error = '' } = (await response.json().catch(() => ({}))) as { error?: string }
    return ERRORS[error] ?? '没寄出去，稍后再试一次。'
  } catch {
    return '没寄出去，检查一下网络再试。'
  }
}

const DRAFT = 'beiershuo.letter-draft'

export function readDraft() {
  try { return window.localStorage.getItem(DRAFT) ?? '' } catch { return '' }
}

export function saveDraft(text: string) {
  try {
    if (text.trim()) window.localStorage.setItem(DRAFT, text)
    else window.localStorage.removeItem(DRAFT)
  } catch { /* private mode: the draft lives only while the dialog is open */ }
}

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
