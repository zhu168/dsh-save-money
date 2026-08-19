/**
 * dsh-save-money — OpenCode Go usage transport (Host side).
 *
 * Fetches the OpenCode Go plan-window usage from OpenCode's official usage
 * endpoint and fails closed on any error, exactly like the DeepSeek balance
 * transport in src/balance-host.ts:
 *
 *   GET https://opencode.ai/zen/go/v1/usage
 *   Authorization: Bearer <opencode-go key>    (+ x-api-key belt-and-suspenders)
 *
 *   → { usage: { rolling:  { percent, resetsAt },
 *                weekly:   { percent, resetsAt },
 *                monthly:  { percent, resetsAt } } }
 *
 * `percent` is the USED percent (0-100, integer) per window; the client shows
 * the REMAINING percent (100 - percent) plus the reset countdown. The values
 * are account-wide and match OpenCode's own dashboard accounting.
 *
 * Inlined into the host plugin body at build time (scripts/build.js): no
 * imports survive, so cross-module references are `declare`d for standalone
 * type-checking and resolve to the inlined scope at runtime.
 */

// Node/browser globals used by the transport — declared here so the module
// type-checks standalone and the dynamic sandbox (no process globals) never
// trips over them.
declare const fetch: any
declare const AbortSignal: any
declare const setTimeout: any
declare const clearTimeout: any

/** Cache window; the header polls the balance endpoint, so keep the upstream call rare. */
export const GO_CACHE_MS = 60000

/** Hard ceiling for one upstream attempt (see balance-host.ts for rationale). */
const GO_TIMEOUT_MS = 5000

/** Official OpenCode Go usage endpoint (auth via Bearer + x-api-key). */
const GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

/**
 * Race a promise against a timeout so a hung subprocess or service call can
 * NEVER pin the usage service (and therefore the plugin) forever.
 */
function goWithTimeout(p: Promise<any>, ms: number, message: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * Create the OpenCode Go usage service for one plugin instance.
 * @param ctx - plugin context (ctx.get for credentials / subprocess).
 * @param opts.sandbox - true in the dynamic-plugin sandbox (no real fetch);
 *   false in the official module form (Node fetch available).
 */
export function createGoUsageService(ctx: any, opts: { sandbox: boolean }): { query(): Promise<any> } {
  let cache: { at: number; data: any } | null = null
  let inFlight: Promise<any> | null = null
  return {
    query(): Promise<any> {
      const now = Date.now()
      if (cache && now - cache.at < GO_CACHE_MS) return Promise.resolve(cache.data)
      if (inFlight) return inFlight
      inFlight = (async () => {
        let out: any
        try {
          out = await goWithTimeout(fetchGoUsage(ctx, opts.sandbox), GO_TIMEOUT_MS, 'opencode go usage upstream timeout')
        } catch (e: any) {
          out = { ok: false, error: String((e && e.message) || e) }
        }
        cache = { at: Date.now(), data: out }
        return out
      })().finally(() => { inFlight = null })
      return inFlight
    },
  }
}

/**
 * Resolve the opencode-go API key from DSH credentials (the same store that
 * holds DEEPSEEK_API_KEY; the key is saved under OPENCODE_GO_API_KEY).
 */
async function resolveGoKey(ctx: any): Promise<string | undefined> {
  const creds = ctx.get('credentials')
  if (!creds || typeof creds.resolve !== 'function') return undefined
  return creds.resolve('OPENCODE_GO_API_KEY').then((r: any) => r && r.value).catch(() => undefined)
}

/** Normalize one window object ({status, percent, resetsAt}); null when absent. */
function pickWindow(w: any): any {
  if (!w || typeof w !== 'object') return null
  return {
    status: typeof w.status === 'string' ? w.status : '',
    percent: typeof w.percent === 'number' ? w.percent : null,
    resetsAt: typeof w.resetsAt === 'string' && w.resetsAt.length > 0 ? w.resetsAt : null,
  }
}

/** One upstream usage request (no caching; see the service wrapper). */
async function fetchGoUsage(ctx: any, sandbox: boolean): Promise<any> {
  const key = await resolveGoKey(ctx)
  if (!key) return { ok: false, error: 'no OPENCODE_GO_API_KEY credential' }
  try {
    let status = 0
    let text = ''
    if (!sandbox && typeof fetch === 'function') {
      // Official module form runs in Node: real fetch is available.
      const res = await fetch(GO_USAGE_URL, {
        headers: {
          authorization: 'Bearer ' + key,
          'x-api-key': key,
          accept: 'application/json',
        },
        signal: typeof AbortSignal !== 'undefined' && AbortSignal && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(10000)
          : undefined,
      })
      status = res.status
      text = await res.text()
    } else {
      // Dynamic sandbox: `fetch` exists but is a guard stub that throws on
      // call — run curl via the subprocess service (mirrors balance-host.ts).
      const sub = ctx.get('subprocess')
      if (!sub || typeof sub.spawn !== 'function') {
        return { ok: false, error: 'no fetch or subprocess available for opencode go usage' }
      }
      let done: any = null
      let raw = ''
      try {
        const handle = sub.spawn({
          argv: ['curl', '-sS', '-f', '-m', '10',
            '-H', 'Authorization: Bearer ' + key,
            '-H', 'x-api-key: ' + key,
            '-H', 'Accept: application/json',
            GO_USAGE_URL],
          cwd: '.',
          stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 4096 } },
          graceMs: 12000,
        })
        const settle = typeof handle.done === 'function'
          ? goWithTimeout(Promise.resolve(handle.done()), GO_TIMEOUT_MS, 'opencode go usage curl timeout')
          : goWithTimeout(Promise.resolve(handle.done), GO_TIMEOUT_MS, 'opencode go usage curl timeout')
        done = await settle
        try { if (handle && typeof handle.kill === 'function') handle.kill() } catch (e) { /* best-effort */ }
        const collected = handle.collected && handle.collected.stdout
        raw = collected && typeof collected.readFrom === 'function'
          ? collected.readFrom(0).text
          : ''
      } catch (e: any) {
        return { ok: false, error: 'opencode go usage subprocess failed: ' + String((e && e.message) || e) }
      }
      status = done && done.exitCode === 0 ? 200 : (done && typeof done.exitCode === 'number' ? done.exitCode : 0)
      text = raw || ''
    }
    let data: any = null
    try { data = JSON.parse(text) } catch (e) { /* non-JSON body */ }
    const usage = data && typeof data === 'object' ? data.usage : null
    if (usage && typeof usage === 'object') {
      return {
        ok: status >= 200 && status < 300,
        httpStatus: status,
        rolling: pickWindow(usage.rolling),
        weekly: pickWindow(usage.weekly),
        monthly: pickWindow(usage.monthly),
      }
    }
    return { ok: false, httpStatus: status, error: 'unexpected response: ' + text.slice(0, 200) }
  } catch (e: any) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}
