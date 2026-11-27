/**
 * The site is static files; this Worker only runs for /stardust/*, which it relays to PostHog. Statistics then go
 * to the site's own address, so they arrive from mainland China (where posthog.com is unreliable) and past most
 * blockers. Everything else is served by the assets layer without invoking the Worker (see wrangler.jsonc).
 */

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
}

/** Keep in step with RELAY in src/analytics.ts. */
const RELAY = '/stardust'
// The PostHog project's region: us.i.posthog.com / us-assets.i.posthog.com, or the eu- equivalents.
const API_HOST = 'us.i.posthog.com'
const ASSET_HOST = 'us-assets.i.posthog.com'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== RELAY && !url.pathname.startsWith(`${RELAY}/`)) return env.ASSETS.fetch(request)
    const path = url.pathname.slice(RELAY.length) + url.search
    // The SDK's lazily loaded pieces and remote config come from the assets host; events go to the API host.
    if (path.startsWith('/static/') || path.startsWith('/array/')) return fetch(`https://${ASSET_HOST}${path}`)

    const headers = new Headers(request.headers)
    // PostHog locates visitors by IP; without this every visit would look like it came from Cloudflare.
    headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') ?? '')
    headers.delete('cookie')
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
    return fetch(`https://${API_HOST}${path}`, { method: request.method, headers, body })
  },
}
