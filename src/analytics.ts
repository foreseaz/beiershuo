/**
 * Visits and listening, counted in PostHog. Only the deployed site counts; local development sends nothing.
 *
 * - Nothing is stored in the browser (no cookie, no local storage), so there is no consent banner. The price: each
 *   page load counts as a new visitor, so someone who comes back the same day counts twice. PostHog's own cookieless
 *   mode would count them once, but it drops the IP before locating visitors, and where listeners are matters more.
 * - Sent through /stardust on the site's own address (worker/index.ts), so it arrives from mainland China and past
 *   most blockers.
 * - Loaded after the page has finished loading, so it never holds up the opening. Anything tracked before then waits
 *   in a queue.
 * - Only what is listed in README · 统计: page views and leaves, and a few named actions. No click autocapture, no
 *   session recordings.
 */
type Client = typeof import('posthog-js/dist/module.slim').default
type Properties = Record<string, string | number | boolean | null | undefined>

/** The project's public key. It is meant to sit in the page: it can only send events, not read them. */
const KEY: string = 'phc_kPT9wvef52YAmguozaEFZ37YiDfNoeN4eftvYLFTnqm9'
/** Where PostHog's own links (and its toolbar) point; must match the project's region, as in worker/index.ts. */
const UI_HOST = 'https://us.posthog.com'
/** Keep in step with RELAY in worker/index.ts. */
const RELAY = '/stardust'

const enabled = import.meta.env.PROD && KEY !== ''
let client: Client | null = null
const waiting: [string, Properties][] = []

function load() {
  import('posthog-js/dist/module.slim')
    .then(({ default: posthog }) => {
      posthog.init(KEY, {
        api_host: new URL(RELAY, window.location.origin).href,
        ui_host: UI_HOST,
        defaults: '2026-08-30',
        persistence: 'memory',
        // Page views come from App, one per page (the map, or an entity or index page): moving around the map only
        // rewrites the query string and is counted as named actions instead.
        capture_pageview: false,
        capture_pageleave: true,
        autocapture: false,
        rageclick: false,
        capture_dead_clicks: false,
        capture_heatmaps: false,
        capture_exceptions: false,
        capture_performance: false,
        disable_session_recording: true,
        disable_surveys: true,
        disable_product_tours: true,
        disable_conversations: true,
        disable_web_experiments: true,
        advanced_disable_flags: true,
        // Anonymous visits only: no person records, and no $set event on every load.
        person_profiles: 'never',
      })
      client = posthog
      for (const [event, properties] of waiting.splice(0)) posthog.capture(event, properties)
    })
    .catch(() => { waiting.length = 0 })
}

if (enabled) {
  if (document.readyState === 'complete') load()
  else window.addEventListener('load', load, { once: true })
}

/** Record one event. Does nothing off the deployed site. */
export function track(event: string, properties: Properties = {}) {
  if (!enabled) return
  if (client) client.capture(event, properties)
  else waiting.push([event, properties])
}

/** A page view for the address now in the bar. */
export const pageview = () => track('$pageview')
