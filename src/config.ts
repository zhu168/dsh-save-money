/**
 * dsh-save-money — Config controller (single source of truth for settings).
 *
 * Owns the persisted settings: defaults, validation, load/persist to the
 * workspace file (save-money.config.json), the config-location resolver
 * (pointer file + candidate directories), and the applyConfig/snapshot pair.
 * Extracted from src/host.ts so the plugin body stays small and this module is
 * independently testable.
 *
 * Inlined into the Host plugin body at build time (scripts/build.js) — same
 * mechanism as src/core.ts and src/balance-host.ts. It exports factories and
 * plain functions only; the apply() glue in host.ts calls createConfig().
 */

/** Language choice: 'auto' follows the browser; the rest are explicit locales. */
type LangChoice = 'auto' | 'zh' | 'zh-TW' | 'en' | 'de' | 'fr' | 'es' | 'it' | 'pt' | 'ja' | 'ko'

/** Per-model-tier save-mode toggles (v1.4.1). Checked = paused in windows. */
export interface ModelApply {
  'official-flash': boolean
  'official-pro': boolean
  'opencode-flash': boolean
  'opencode-pro': boolean
}

export interface SaveMoneyConfig {
  enabled: boolean
  timezone: string
  warnMinutes: number
  windows: TimeWindow[]
  reconcileOnStart: boolean
  lang: LangChoice
  showBalance: boolean
  showOpenCodeGo: boolean
  displaySource: string
  modelApply: ModelApply
}

/** Defaults: official flash/pro apply (paused); opencode tiers exempt. */
export const CONFIG_DEFAULTS: SaveMoneyConfig = {
  enabled: false,
  timezone: 'Asia/Shanghai',
  warnMinutes: 5,
  windows: [],
  reconcileOnStart: true,
  lang: 'auto',
  showBalance: false,
  // OpenCode Go quota display is ON by default: a configured opencode-go
  // (OPENCODE_GO_API_KEY present) shows its 5h/week/month usage immediately,
  // matching "I configured opencode-go, so show its quota".
  showOpenCodeGo: true,
  displaySource: 'auto',
  modelApply: {
    'official-flash': true,
    'official-pro': true,
    'opencode-flash': false,
    'opencode-pro': false,
  },
}

export const LANGS: LangChoice[] = ['auto', 'zh', 'zh-TW', 'en', 'de', 'fr', 'es', 'it', 'pt', 'ja', 'ko']
export const MODEL_APPLY_KEYS = ['official-flash', 'official-pro', 'opencode-flash', 'opencode-pro'] as const

/** Known header display sources (which provider's data to show). */
export const DISPLAY_SOURCES = ['auto', 'deepseek-official', 'opencode-go'] as const
export function isKnownDisplaySource(s: string): boolean {
  return (DISPLAY_SOURCES as readonly string[]).includes(s)
}

export const CONFIG_FILE = 'save-money.config.json'
export const POINTER_FILE = 'save-money-config-path.json'

// Node/browser globals used by the config resolver — declared here so this
// module type-checks standalone and the dynamic sandbox (no process globals)
// never trips over them.
declare const process: any
declare const console: any

// Pure time helpers inlined from src/core.ts at build time — the `import`
// below keeps dist/config.js a runnable ESM module for the unit tests; the
// inline pass strips the import line (scripts/build.js stripExports) so the
// same-scope core helpers resolve at runtime inside the plugin body.
import { isValidTz, validateWindows } from './core.js'
import type { TimeWindow } from './core.js'

/**
 * Deferred services (read at call time, not captured once): the official
 * bundle can activate before fs/sessions/sandboxPolicy exist, and a late fs is
 * picked up the moment it registers. The host passes getters that re-read
 * ctx.get(name) each call.
 */
export interface ConfigDeps {
  getFs(): any
  getSessions(): any
  getAgents(): any
  getSandboxPolicy(): any
  /** Called after a config change that opens the gate (wake suspended waiters). */
  onConfigOpened?: () => void
}

/** DSH user dir (~/.dsh): exists on Windows / macOS / Linux. */
export function dshHome(): string {
  try {
    const h = (typeof process !== 'undefined' && process && process.env)
      ? (process.env.DSH_HOME || process.env.USERPROFILE || process.env.HOME)
      : ''
    return typeof h === 'string' && h.length > 0 ? h.replace(/[\\/]+$/, '') : ''
  } catch (e) { return '' }
}

/** Session working directory (any of the shapes DSH exposes). */
function sessionCwdOf(s: any): string {
  const c = s && (s.meta && s.meta.cwd || s.header && s.header.cwd || s.cwd)
  return typeof c === 'string' ? c : ''
}

/** Read the pointer file (best-effort; '' when absent/unreadable). */
async function readPointer(deps: ConfigDeps): Promise<string> {
  const home = dshHome()
  const fs = deps.getFs()
  if (!home || !fs) return ''
  try {
    const target = await fs.resolve(POINTER_FILE, { cwd: home })
    const text = await fs.readText(target)
    const data = JSON.parse(text)
    const p = data && typeof data.path === 'string' ? data.path : ''
    return p.replace(/[\\/]+$/, '')
  } catch (e) { return '' }
}

/** Record the last real config dir in ~/.dsh (best-effort; never throws). */
async function writePointer(deps: ConfigDeps, dir: string): Promise<void> {
  const home = dshHome()
  const fs = deps.getFs()
  if (!home || !fs || !dir) return
  try {
    const target = await fs.resolve(POINTER_FILE, { cwd: home })
    await fs.writeText(target, JSON.stringify({ path: dir }, null, 2), undefined, undefined,
      { mode: 'workspace-write', workspaceRoot: home })
  } catch (e) { /* best-effort */ }
}

/**
 * Candidate config directories, highest priority first. The pointer (the last
 * real location) is handled separately in resolveWorkspaceRoot.
 */
function candidateRoots(deps: ConfigDeps, defaultWorkspaceRoot: string): string[] {
  const out: string[] = []
  const push = (c: string) => {
    c = String(c || '').replace(/[\\/]+$/, '')
    if (c && !out.includes(c)) out.push(c)
  }
  // 1. the calling session (agents.currentInitiator): the session that
  //    actually uses the plugin, so config follows the user's workspace.
  try {
    const agentsSvc = deps.getAgents()
    const init = agentsSvc && typeof agentsSvc.currentInitiator === 'function'
      ? agentsSvc.currentInitiator()
      : undefined
    const sessionsSvc = deps.getSessions()
    if (init && sessionsSvc && typeof sessionsSvc.get === 'function') {
      push(sessionCwdOf(sessionsSvc.get(init.id) || init))
    }
  } catch (e) { /* skip */ }
  // 2. every session whose cwd matches the repo basename (last wins, so the
  //    newest checkout is preferred when several exist).
  const sessionsSvc = deps.getSessions()
  if (sessionsSvc && typeof sessionsSvc.list === 'function') {
    try {
      const matches: string[] = []
      for (const s of sessionsSvc.list()) {
        const c = sessionCwdOf(s).replace(/[\\/]+$/, '')
        if (/dsh-save-money$/i.test(c)) matches.push(c)
      }
      for (const m of matches) push(m)
    } catch (e) { /* skip */ }
  }
  // 3. process.cwd() itself (official module form only; the harness may be
  //    started from the repo checkout).
  try {
    if (typeof process !== 'undefined' && process && typeof process.cwd === 'function') {
      push(String(process.cwd()))
    }
  } catch (e) { /* skip */ }
  // 4. sibling of process.cwd() named dsh-save-money — the README
  //    quick-install layout: ~/app/dsh-save-money next to
  //    ~/app/deepseek-harness, harness started from the latter.
  try {
    if (typeof process !== 'undefined' && process && typeof process.cwd === 'function') {
      const cwd = String(process.cwd()).replace(/[\\/]+$/, '')
      const idx = Math.max(cwd.lastIndexOf('\\'), cwd.lastIndexOf('/'))
      if (idx > 0) push(cwd.slice(0, idx + 1) + 'dsh-save-money')
    }
  } catch (e) { /* skip */ }
  // 5. sandboxPolicy fallback (the harness install dir).
  push(defaultWorkspaceRoot)
  // 6. the DSH user dir (account-level, always reachable): a reliability net
  //    when no session/workspace candidate is usable, and — with DSH_HOME set
  //    (the managed desktop deploy) — the preferred home (same location the
  //    balance history already persists to, so writes are guaranteed to work).
  push(dshHome())
  return out
}

/**
 * Create the config controller bound to one plugin instance.
 *
 * `deps` supplies the deferred service getters and an optional gate-open
 * callback. The returned controller owns the mutable config state and exposes
 * the persistence + validation surface the rest of the plugin calls.
 */
export function createConfig(deps: ConfigDeps) {
  // Mutable config state. `cfgRef` is a stable object whose `.cfg` field is
  // replaced on load/apply — callers that hold `cfgRef` always see the latest.
  const cfgRef: { cfg: SaveMoneyConfig } = { cfg: { ...CONFIG_DEFAULTS, windows: [] as TimeWindow[] } }
  let configLoaded = false
  let configPath = ''
  let resolvedConfigDir = ''
  const defaultWorkspaceRoot: string = (() => {
    const sandboxPolicy = deps.getSandboxPolicy()
    return (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot.length > 0)
      ? sandboxPolicy.workspaceRoot
      : ''
  })()

  /** The first directory that actually contains a config file wins; see
   * candidateRoots for the priority list. */
  const resolveWorkspaceRoot = async (): Promise<string> => {
    const fs = deps.getFs()
    if (!fs) return defaultWorkspaceRoot
    const ptr = await readPointer(deps)
    if (ptr) {
      try {
        await fs.readText(await fs.resolve(CONFIG_FILE, { cwd: ptr }))
        resolvedConfigDir = ptr
        return ptr
      } catch (e) { /* pointer stale — fall through to candidates */ }
    }
    const roots = candidateRoots(deps, defaultWorkspaceRoot)
    for (const dir of roots) {
      if (!dir) continue
      try {
        await fs.readText(await fs.resolve(CONFIG_FILE, { cwd: dir }))
        resolvedConfigDir = dir
        return dir
      } catch (e) { /* no config here — try next */ }
    }
    // No config anywhere yet: prefer a repo-named candidate (README layout);
    // on the managed desktop deploy (DSH_HOME set) the cwd resolution can
    // yield an unwritable bogus path (e.g. "C:\\Users\\dsh-save-money"), so
    // prefer the DSH user dir — guaranteed writable.
    let target = ''
    for (const dir of roots) {
      if (dir && /dsh-save-money$/i.test(dir)) { target = dir; break }
    }
    const home = dshHome()
    const managed = !!(typeof process !== 'undefined' && process && process.env && process.env.DSH_HOME)
    resolvedConfigDir = (managed && home ? home : (target || roots[0])) || defaultWorkspaceRoot
    return resolvedConfigDir
  }

  const persistConfig = async (): Promise<void> => {
    const fs = deps.getFs()
    if (!fs) {
      console.error('[save-money] persist skipped: fs service unavailable')
      return
    }
    try {
      const workspaceRoot = await resolveWorkspaceRoot()
      if (!workspaceRoot) return
      const target = await fs.resolve(CONFIG_FILE, { cwd: workspaceRoot })
      configPath = fs.processPath ? String(fs.processPath(target)) : String(target && (target.path || target.filePath || ''))
      await fs.writeText(target, JSON.stringify(snapshot(), null, 2), undefined, undefined,
        { mode: 'workspace-write', workspaceRoot })
      await writePointer(deps, workspaceRoot)
      console.log('[save-money] config persisted to ' + workspaceRoot + '\\' + CONFIG_FILE)
    } catch (e: any) {
      console.error('[save-money] persist failed: ' + String((e && e.message) || e))
    }
  }

  const loadConfig = async (): Promise<void> => {
    const fs = deps.getFs()
    if (!fs) {
      console.error('[save-money] load skipped: fs service unavailable')
      return
    }
    try {
      const workspaceRoot = await resolveWorkspaceRoot()
      if (!workspaceRoot) return
      const target = await fs.resolve(CONFIG_FILE, { cwd: workspaceRoot })
      configPath = fs.processPath ? String(fs.processPath(target)) : String(target && (target.path || target.filePath || ''))
      const text = await fs.readText(target)
      const data = JSON.parse(text)
      configLoaded = true
      const next = { ...cfgRef.cfg }
      if (typeof data.enabled === 'boolean') next.enabled = data.enabled
      if (typeof data.timezone === 'string' && isValidTz(data.timezone)) next.timezone = data.timezone
      if (typeof data.warnMinutes === 'number' && data.warnMinutes >= 0) next.warnMinutes = data.warnMinutes
      if (typeof data.reconcileOnStart === 'boolean') next.reconcileOnStart = data.reconcileOnStart
      if (typeof data.showBalance === 'boolean') next.showBalance = data.showBalance
      if (typeof data.showOpenCodeGo === 'boolean') next.showOpenCodeGo = data.showOpenCodeGo
      if (typeof data.displaySource === 'string' && isKnownDisplaySource(data.displaySource)) next.displaySource = data.displaySource
      if (data.lang === 'auto' || data.lang === 'zh' || data.lang === 'zh-TW' || data.lang === 'en' ||
          data.lang === 'de' || data.lang === 'fr' || data.lang === 'es' || data.lang === 'it' ||
          data.lang === 'pt' || data.lang === 'ja' || data.lang === 'ko') next.lang = data.lang
      if (Array.isArray(data.windows)) {
        const v = validateWindows(data.windows, next.timezone)
        if (v.ok) next.windows = data.windows.map((w: TimeWindow) => ({ ...w }))
      }
      // modelApply: only adopt tiers the user actually saved (boolean per tier;
      // broken/missing tiers keep the current value). No field → keep default.
      if (data.modelApply && typeof data.modelApply === 'object') {
        const ma: any = { ...next.modelApply }
        for (const key of MODEL_APPLY_KEYS) {
          if (typeof data.modelApply[key] === 'boolean') ma[key] = data.modelApply[key]
        }
        next.modelApply = ma
      }
      // In-place update keeps the `cfgRef.cfg` reference stable, so callers
      // that captured it (e.g. the host's `const cfg = cfgRef.cfg`) always see
      // the latest config without re-reading.
      Object.assign(cfgRef.cfg, next)
      console.log('[save-money] config loaded from ' + workspaceRoot + '\\' + CONFIG_FILE)
    } catch (e: any) {
      console.log('[save-money] no config file (fresh start): ' + String((e && e.message) || e))
    }
  }

  /**
   * Apply a partial patch with full validation. On success persists and (when
   * the gate opens) wakes waiters via deps.onConfigOpened.
   */
  function applyConfig(patch: any): any {
    // Whitelist: only known config keys are accepted, so a malformed/unknown
    // patch (e.g. `evil: 42`, `enabled: "yes"`) can never pollute the live
    // config object. Boolean fields are type-checked below.
    const p: any = (patch && typeof patch === 'object') ? patch : {}
    const next: any = { ...cfgRef.cfg }
    for (const key of ['enabled', 'timezone', 'warnMinutes', 'windows', 'reconcileOnStart', 'lang', 'showBalance', 'showOpenCodeGo', 'displaySource', 'modelApply'] as const) {
      if (p[key] !== undefined) next[key] = p[key]
    }
    if (next.windows === undefined) next.windows = []
    if (next.enabled !== undefined && typeof next.enabled !== 'boolean') {
      return { ok: false, error: 'enabled must be a boolean' }
    }
    if (next.reconcileOnStart !== undefined && typeof next.reconcileOnStart !== 'boolean') {
      return { ok: false, error: 'reconcileOnStart must be a boolean' }
    }
    const v = validateWindows(next.windows, next.timezone)
    if (!v.ok) return { ok: false, error: v.error }
    if (next.timezone !== undefined && !isValidTz(next.timezone)) {
      return { ok: false, error: 'invalid IANA timezone: ' + next.timezone }
    }
    if (next.warnMinutes !== undefined && (!Number.isFinite(next.warnMinutes) || next.warnMinutes < 0)) {
      return { ok: false, error: 'warnMinutes must be >= 0' }
    }
    if (next.showBalance !== undefined && typeof next.showBalance !== 'boolean') {
      return { ok: false, error: 'showBalance must be a boolean' }
    }
    if (next.showOpenCodeGo !== undefined && typeof next.showOpenCodeGo !== 'boolean') {
      return { ok: false, error: 'showOpenCodeGo must be a boolean' }
    }
    if (next.displaySource !== undefined && !isKnownDisplaySource(next.displaySource)) {
      return { ok: false, error: 'displaySource must be auto/deepseek-official/opencode-go' }
    }
    if (next.modelApply !== undefined) {
      if (!next.modelApply || typeof next.modelApply !== 'object') {
        return { ok: false, error: 'modelApply must be an object' }
      }
      for (const key of MODEL_APPLY_KEYS) {
        if (next.modelApply[key] !== undefined && typeof next.modelApply[key] !== 'boolean') {
          return { ok: false, error: 'modelApply.' + key + ' must be a boolean' }
        }
      }
    }
    if (next.lang !== undefined && !LANGS.includes(next.lang)) {
      return { ok: false, error: 'lang must be one of auto/zh/zh-TW/en/de/fr/es/it/pt/ja/ko' }
    }
    // modelApply per-tier merge: a patch only overrides the tiers it names,
    // so { modelApply: { 'opencode-pro': true } } keeps the official tiers.
    if (patch && patch.modelApply && typeof patch.modelApply === 'object') {
      const merged: Record<string, boolean> = { ...cfgRef.cfg.modelApply }
      for (const key of MODEL_APPLY_KEYS) {
        if (typeof patch.modelApply[key] === 'boolean') merged[key] = patch.modelApply[key]
      }
      next.modelApply = merged as any
    }
    // In-place update keeps the `cfgRef.cfg` reference stable (see loadConfig).
    Object.assign(cfgRef.cfg, next)
    // Delegate the wake decision to the host: the gate is open only when the
    // new config actually releases suspended requests (disable / window
    // change), so the host wakes waiters only then.
    if (deps.onConfigOpened) deps.onConfigOpened()
    void persistConfig()
    return { ok: true, config: snapshot() }
  }

  function snapshot() {
    return {
      enabled: cfgRef.cfg.enabled,
      timezone: cfgRef.cfg.timezone,
      warnMinutes: cfgRef.cfg.warnMinutes,
      reconcileOnStart: cfgRef.cfg.reconcileOnStart,
      lang: cfgRef.cfg.lang,
      showBalance: cfgRef.cfg.showBalance,
      showOpenCodeGo: cfgRef.cfg.showOpenCodeGo,
      displaySource: cfgRef.cfg.displaySource,
      modelApply: { ...cfgRef.cfg.modelApply },
      windows: cfgRef.cfg.windows.map((w) => ({ ...w })),
    }
  }

  return {
    get cfg(): SaveMoneyConfig { return cfgRef.cfg },
    get configLoaded(): boolean { return configLoaded },
    get configPath(): string { return configPath },
    get resolvedConfigDir(): string { return resolvedConfigDir },
    get defaultWorkspaceRoot(): string { return defaultWorkspaceRoot },
    load: loadConfig,
    persist: persistConfig,
    apply: applyConfig,
    snapshot,
    resolveWorkspaceRoot,
  }
}
