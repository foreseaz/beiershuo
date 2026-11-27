/**
 * The site is static files; this Worker only does two small jobs (see wrangler.jsonc):
 *
 * - fetch: relays /stardust/* to PostHog. Statistics then go to the site's own address, so they arrive from mainland
 *   China (where posthog.com is unreliable) and past most blockers. Everything else is served by the assets layer
 *   without invoking the Worker.
 * - scheduled: the timer for new episodes. It compares the newest episodes in Apple's catalog with the atlas the site
 *   serves, and when one is missing it starts the GitHub deploy, which does the real work (sync, export with the font
 *   subsets, check, deploy, curation issue). GitHub's own schedule proved unreliable, so the timer lives here.
 */

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  /** Fine-grained GitHub token for this repository only, with Actions read and write. Set as a Worker secret. */
  GITHUB_TOKEN?: string
}

/** Keep in step with RELAY in src/analytics.ts. */
const RELAY = '/stardust'
// The PostHog project's region: us.i.posthog.com / us-assets.i.posthog.com, or the eu- equivalents.
const API_HOST = 'us.i.posthog.com'
const ASSET_HOST = 'us-assets.i.posthog.com'

/** Keep in step with APPLE_SHOW_ID and APPLE_LOOKUP in pipeline/catalog.py. */
const LATEST = 'https://itunes.apple.com/lookup?id=1868979722&country=au&entity=podcastEpisode&limit=10'
const REPOSITORY = 'foreseaz/beiershuo'
const WORKFLOW = 'deploy.yml'
/** A deploy the timer started less than this long ago is left to finish, or to fail, before it starts another. */
const PATIENCE_MS = 2 * 60 * 60 * 1000

type Episode = { id: string; title: string }
type Run = { status: string; conclusion: string | null; created_at: string; html_url: string }

/** The newest episodes in Apple's catalog, by the same id the atlas uses (the episode GUID). */
async function latestEpisodes(): Promise<Episode[]> {
  const response = await fetch(LATEST, { headers: { 'User-Agent': 'Beiershuo-catalog/1.0' } })
  if (!response.ok) throw new Error(`Apple lookup answered ${response.status}`)
  const { results = [] } = (await response.json()) as { results?: { kind?: string; episodeGuid?: string; trackName?: string }[] }
  return results
    .filter(row => row.kind === 'podcast-episode' && row.episodeGuid)
    .map(row => ({ id: row.episodeGuid!, title: (row.trackName ?? '').trim() }))
}

/** The atlas this version of the site serves, as text: searching it for ids keeps well inside the CPU limit. */
async function liveAtlas(env: Env) {
  const response = await env.ASSETS.fetch(new Request('https://assets.local/data/v1/atlas.json'))
  if (!response.ok) throw new Error(`The site's atlas answered ${response.status}`)
  return response.text()
}

function github(env: Env, path: string, init: RequestInit = {}) {
  return fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'User-Agent': 'beiershuo-timer',
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers,
    },
  }).then(async response => {
    if (!response.ok) throw new Error(`GitHub ${path} answered ${response.status}: ${(await response.text()).slice(0, 200)}`)
    return response
  })
}

const names = (episodes: Episode[]) => episodes.map(episode => episode.title.split(/[.。]/)[0] || episode.id).join('、')

async function checkForEpisodes(env: Env) {
  const [latest, atlas] = await Promise.all([latestEpisodes(), liveAtlas(env)])
  const missing = latest.filter(episode => !atlas.includes(`"${episode.id}"`))

  if (!env.GITHUB_TOKEN) {
    if (missing.length) throw new Error(`${names(missing)} is not on the site, and there is no GITHUB_TOKEN to start a deploy`)
    console.warn('Up to date, but there is no GITHUB_TOKEN: the next new episode will not be published')
    return
  }

  // Read the last run the timer started on every check, new episode or not: it also proves the token still works.
  const runs = (await (await github(env, `/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=1`)).json()) as { workflow_runs: Run[] }
  if (!missing.length) {
    console.log(`Up to date with Apple's newest ${latest.length} episodes`)
    return
  }
  const last = runs.workflow_runs[0]
  if (last && (last.status !== 'completed' || Date.now() - Date.parse(last.created_at) < PATIENCE_MS)) {
    console.log(`${names(missing)} is not on the site yet; waiting on ${last.html_url} (${last.status}${last.conclusion ? `, ${last.conclusion}` : ''})`)
    return
  }
  await github(env, `/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs: { only_if_changed: 'true' } }),
  })
  console.log(`Started a deploy for ${names(missing)}`)
}

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

  async scheduled(_controller: unknown, env: Env): Promise<void> {
    try {
      await checkForEpisodes(env)
    } catch (error) {
      // Logged as well as thrown, so the reason shows in Workers Logs and the run is marked failed.
      console.error('New-episode check failed:', error)
      throw error
    }
  },
}
