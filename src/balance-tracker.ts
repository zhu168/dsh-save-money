/**
 * dsh-save-money — Balance history sampling, persistence and query (Host side).
 *
 * Wraps the balance transport (createBalanceService) with:
 *  - sampling: every 5 minutes the current balance is recorded into the
 *    history queue, tagged with a local-activity signal;
 *  - persistence: the history is saved to ~/.dsh/dsh-save-money-balance.json
 *    (account-level, shared across projects; a keyId fingerprint invalidates
 *    the history when the API key changes);
 *  - query: the /save-money/balance response — latest balance + spend stats
 *    over the last 10min / 1h / 24h + per-10-minute spend bars.
 *
 * Inlined into the host plugin body at build time (scripts/build.js): no
 * imports survive, so cross-module references are `declare`d for standalone
 * type-checking and resolve to the inlined scope at runtime.
 *
 * `S` is the shared plugin state object: S.balanceDirty / S.lastRequestProvider
 * / S.lastActivityAt cross the module boundary (set by the gate's onRequest,
 * read here and by status()).
 */

// Sandbox global (declared so the module type-checks standalone; the host
// body provides it at runtime).
declare const console: any

declare const dshHome: () => string
declare const BALANCE_HISTORY_FILE: string
declare const SAMPLE_MS: number
declare function createBalanceService(ctx: any, opts: { sandbox: boolean }): { query(): Promise<any> }
declare function createGoUsageService(ctx: any, opts: { sandbox: boolean }): { query(): Promise<any> }
declare function createBalanceHistory(): {
  record(total: number, at?: number, activity?: boolean): void
  latest(): number | null
  totalAgo(ms: number, now?: number): number | null
  spend(ms: number, now?: number): number | null
  points(): { at: number; total: number; activity?: boolean }[]
  load(persisted: { at: number; total: number; activity?: boolean }[]): void
  clear(): void
}
declare function keyFingerprint(key: string): string
declare function serializeBalanceHistory(p: { keyId: string; points: { at: number; total: number; activity?: boolean }[] }): string
declare function parseBalanceHistory(text: string): { keyId: string; points: { at: number; total: number; activity?: boolean }[] } | null
declare function spendBars(points: { at: number; total: number; activity?: boolean }[], now?: number, count?: number, barMs?: number, tz?: string): { at: number; spent: number | null; activity: boolean }[]
declare function alignWallClock(tz: string, ms: number, stepMs: number): number | undefined

/**
 * Create the balance tracker for one plugin instance.
 * @param ctx - plugin context (ctx.get for credentials / fs).
 * @param S - shared plugin state (S.balanceDirty / S.lastRequestProvider /
 *   S.lastActivityAt).
 * @param deps.getFs - returns the fs service (may be undefined until late).
 * @param deps.getCfg - returns the live config (showBalance / timezone).
 * @param deps.sandbox - true in the dynamic-plugin sandbox (no real fetch).
 */
export function createBalanceTracker(ctx: any, S: any, deps: { getFs: () => any; getCfg: () => any; sandbox: boolean }) {
  const balanceSvc = createBalanceService(ctx, { sandbox: deps.sandbox })
  const goSvc = createGoUsageService(ctx, { sandbox: deps.sandbox })
  const balanceHistory = createBalanceHistory()
  const historyFile = (() => {
    const home = dshHome()
    return home ? home + (home.includes('\\') ? '\\' : '/') + BALANCE_HISTORY_FILE : ''
  })()
  let historyKeyId: string | null = null
  // Dirty flag lives on the SHARED state object S: the host body's unload
  // flush and 5-minute write throttle gate on S.historyDirty, so a local flag
  // here would make those persist call sites dead code.
  const markDirty = () => { S.historyDirty = true }

  // Record one balance sample (with the current activity signal) and mark the
  // history dirty for the next write.
  const recordBalance = (total: number): void => {
    const now = Date.now()
    // Activity signal: a llm/stream request within SAMPLE_MS → this
    // environment produced model activity.
    const activity = S.lastActivityAt > 0 && now - S.lastActivityAt < SAMPLE_MS
    balanceHistory.record(total, now, activity)
    markDirty()
  }
  // Load the persisted history: adopted only when its keyId matches the
  // current credential fingerprint (otherwise the old account's trail is
  // void). A credential that cannot be RESOLVED (transient failure) keeps the
  // parsed history — only a resolved key that differs discards it.
  const loadBalanceHistory = async (): Promise<void> => {
    const fs = deps.getFs()
    if (!fs || !historyFile) return
    try {
      const text = await fs.readText(await fs.resolve(historyFile))
      const parsed = parseBalanceHistory(text)
      if (!parsed) { console.log('[save-money] balance history: unreadable, starting fresh'); return }
      const creds = ctx.get('credentials')
      const key = creds && typeof creds.resolve === 'function'
        ? await creds.resolve('DEEPSEEK_API_KEY').then((r: any) => r && r.value).catch(() => undefined)
        : undefined
      if (typeof key === 'string' && key.length > 0) {
        historyKeyId = keyFingerprint(key)
        if (parsed.keyId !== historyKeyId) {
          console.log('[save-money] balance history: key changed (' + String(parsed.keyId) + ' → ' + String(historyKeyId) + '), discarding old history')
          balanceHistory.clear()
          return
        }
      }
      // key unresolved → keep the parsed history (transient credential
      // failure must not destroy the old account's trail); the fingerprint
      // is re-checked on the next load.
      balanceHistory.load(parsed.points)
      console.log('[save-money] balance history loaded: ' + balanceHistory.points().length + ' samples')
    } catch (e: any) {
      console.log('[save-money] balance history: none yet (fresh start)')
    }
  }
  // Write to disk: best-effort, never throws. The dirty flag is cleared only
  // AFTER a successful write, so a failure keeps the marker for the next
  // throttle cycle (and the unload flush).
  const persistBalanceHistory = async (): Promise<void> => {
    const fs = deps.getFs()
    if (!fs || !historyFile) return
    try {
      const creds = ctx.get('credentials')
      const key = creds && typeof creds.resolve === 'function'
        ? await creds.resolve('DEEPSEEK_API_KEY').then((r: any) => r && r.value).catch(() => undefined)
        : undefined
      const kid = typeof key === 'string' && key.length > 0 ? keyFingerprint(key) : historyKeyId
      if (!kid) {
        // No resolved key yet: never overwrite the persisted file with a
        // placeholder fingerprint — wait for the credential to resolve.
        console.log('[save-money] balance history persist skipped: no credential resolved')
        return
      }
      historyKeyId = kid
      const points = balanceHistory.points()
      const target = await fs.resolve(historyFile)
      // Write location: the history file's directory (~/.dsh) acts as the
      // workspaceRoot so the sandbox permits the write.
      const dir = historyFile.slice(0, Math.max(historyFile.lastIndexOf('\\'), historyFile.lastIndexOf('/')))
      await fs.writeText(target, serializeBalanceHistory({ keyId: kid, points }), undefined, undefined,
        { mode: 'workspace-write', workspaceRoot: dir })
      S.historyDirty = false
    } catch (e: any) {
      console.error('[save-money] balance history persist failed: ' + String((e && e.message) || e))
    }
  }
  // Pull one balance and record a history sample (same 5-min window updates,
  // never adds).
  const sampleBalance = async (): Promise<void> => {
    try {
      const out = await balanceSvc.query()
      if (out && out.ok && Array.isArray(out.balance) && out.balance.length > 0 && typeof out.balance[0].total === 'string') {
        const total = parseFloat(out.balance[0].total)
        if (Number.isFinite(total)) recordBalance(total)
      }
    } catch (e) { /* the sampler must never throw */ }
  }
  const balanceQuery = async (): Promise<any> => {
    const cfgQ = deps.getCfg()
    const wantsBalance = cfgQ.showBalance === true
    const wantsGo = cfgQ.showOpenCodeGo === true
    if (!wantsBalance && !wantsGo) return { ok: false, error: 'balance display is disabled' }
    const out = wantsBalance ? await balanceSvc.query() : { ok: false, error: 'balance not enabled' }
    const goUsage = wantsGo ? await goSvc.query() : null
    S.balanceDirty = false // a fresh balance (+ go usage) was just fetched for the client
    // Record this balance as the newest sample (deduped inside the window),
    // then attach the spend stats (DeepSeek balance only).
    if (wantsBalance && out && out.ok && Array.isArray(out.balance) && out.balance.length > 0 && typeof out.balance[0].total === 'string') {
      const total = parseFloat(out.balance[0].total)
      if (Number.isFinite(total)) recordBalance(total)
    }
    // Unified window-clock baseline: the three spend windows and the bar
    // chart share the same "config-timezone integer 10-minute" alignment, so
    // m10 and bars[0] point at the same period (hover card matches the chart)
    // and both land on integer boundaries of the configured timezone
    // (comparable with the official local per-hour billing).
    const nowMs = Date.now()
    const alignedNow = (deps.getCfg().timezone ? alignWallClock(deps.getCfg().timezone, nowMs, 10 * 60 * 1000) : undefined)
      ?? (nowMs - (nowMs % (10 * 60 * 1000)))
    const spendAt = {
      m10: alignedNow - 10 * 60 * 1000,
      h1: alignedNow - 60 * 60 * 1000,
      // h24 spans days: no HH:mm range label (avoids yesterday/today ambiguity)
    }
    // top-level ok = any enabled sub-source succeeded, so the client can
    // store the response and keep the OpenCode Go usage even when the DeepSeek
    // balance itself is unavailable (no credential / relay baseURL / failure).
    const base = wantsBalance ? out : { ok: false, error: 'balance not enabled' }
    const ok = !!((base && base.ok === true) || (goUsage && goUsage.ok === true))
    return {
      ...base,
      ok,
      // OpenCode Go plan-window usage ({ rolling, weekly, monthly } with
      // percent + resetsAt), null when the display is disabled.
      goUsage,
      // Provider of the most recent model request: null when no request has
      // been made yet (show the balance — the official account is queryable),
      // otherwise the client shows the balance only for 'deepseek-official'.
      provider: S.lastRequestProvider,
      spend: {
        m10: balanceHistory.spend(10 * 60 * 1000, alignedNow),
        h1: balanceHistory.spend(60 * 60 * 1000, alignedNow),
        h24: balanceHistory.spend(24 * 60 * 60 * 1000, alignedNow),
      },
      // Window start instants (ms) — the hover card labels the exact ranges.
      spendAt,
      // Last-8h per-10-minute spend bars (index 0 = most recent 10 minutes);
      // same source and alignment as `spend`, drawn by the client on click.
      bars: spendBars(balanceHistory.points(), nowMs, 48, 10 * 60 * 1000, deps.getCfg().timezone),
    }
  }
  return {
    load: loadBalanceHistory,
    persist: persistBalanceHistory,
    sample: sampleBalance,
    query: balanceQuery,
  }
}
