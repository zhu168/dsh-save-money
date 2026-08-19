/**
 * dsh-save-money — Client half (single source of the dynamic-plugin code.client)
 *
 * Browser UI (entry convergence):
 * 1. conversation.session.header.utilities — the only persistent header entry
 *    (next to the Session log): status text "Save · 🟢 Working" (click to open
 *    the settings popover) + the top floating banner (position:fixed, includes
 *    the "End this save mode" button). Rendered by src/ui/header.tsx.
 * 2. settings.section — system settings page "Save-money" (one section in the
 *    settings panel; not a persistent entry).
 *
 * Key implementation notes:
 * - The PAUSED banner copy ("Paused: model requests suspended, no cost, HH:mm
 *   auto-resumes") works with the Host request-level gate: nothing throws, the
 *   request waits before being sent and continues once released.
 * - The banner is registered in the session-header utilities slot (a normal
 *   layout chain) and floats with position:fixed — the shell.overlay container
 *   is pointer-events:none (click-through) and its slot anchor is
 *   display:contents, which broke button hit-testing.
 *
 * Experience notes:
 * - React / host are Client Builtin GLOBAL symbols — use them directly, do not
 *   ctx.get('React').
 * - slots / timer are Services — go through ctx.get / inject.
 * - The dynamic Client half has no browser timer globals (no setInterval) —
 *   use the timer service, and in React effects dispose via the cleanup.
 * - There is no "open settings panel" Client Event — the popover is drawn by
 *   the plugin (fixed + zIndex 10000).
 *
 * i18n: UI strings live in src/i18n/* (10 locale dictionaries + the
 * aggregator), inlined at build time. The language is auto-detected from
 * navigator.language and overridden by the persisted config choice.
 */

declare const React: any
declare const host: any
declare const fetch: any
// ModuleLoader-provided synchronous require: resolves client modules in the
// __DSH_BOOT__ graph, e.g. the DSH system button component
// @deepseek-ai/dsh-client-ui-primitives.
declare const require: any

// --- i18n (moved to src/i18n/*) ---
// Types, the 10 locale dictionaries, detectLang/resolveLang and the translate()
// translator are inlined from src/i18n at build time. client.ts keeps only
// the reactive `currentLang` state and a thin translate(key) wrapper.
type Lang = 'zh' | 'zh-TW' | 'en' | 'de' | 'fr' | 'es' | 'it' | 'pt' | 'ja' | 'ko'
interface Dict {
  [key: string]: string
}
declare const I18N: Record<Lang, Dict>
declare function detectLang(): Lang
declare function resolveLang(cfgLang: string | undefined | null): Lang
declare function t(currentLang: Lang, key: string, vars?: Record<string, string | number>): string
// Language is reactive: currentLang starts from browser detection and is
// overridden by the persisted config choice ('zh'/'zh-TW'/'en'/...) or kept on
// 'auto' (follow the browser) — see refresh() below and the settings dropdown.
let currentLang: Lang = detectLang()
// Plugin name + version shown next to the Save button in the settings popover.
// '__VERSION__' is replaced at build time (scripts/build.js) with the real
// version from package.json — never edit this literal by hand.
const PLUGIN_VERSION = '__VERSION__'
// Local translator bound to the reactive language.
const translate = (key: string, vars?: Record<string, string | number>): string => t(currentLang, key, vars)

// Client UI (src/ui/*): createUi(deps) composes the header entry, settings
// panel, bar chart, floating banner and badge, bound to the shared deps below.
// Inlined at build time (scripts/build.js), so only the signature is declared.
declare function createUi(deps: any): any

return {
  inject: ['timer'],
  async apply(ctx: any) {
    const slots = ctx.get('slots')
    const timer = ctx.timer
    if (!React || !slots || !timer) {
      console.error('[save-money] client apply aborted')
      return
    }

    // DSH system button component (ui-primitives): rounded capsule, tokens
    // adapt to light/dark themes automatically. `require` comes from
    // ModuleLoader; the synchronous require skips the async-load branch, and
    // if that module's script is not registered yet it throws — caught below,
    // falling back to hand-drawn buttons so the UI never hangs.
    let DSHButton: any = undefined
    try {
      DSHButton = (require('@deepseek-ai/dsh-client-ui-primitives') || {}).Button
    } catch (e) {
      console.error('[save-money] ui-primitives unavailable, falling back to hand-drawn buttons: ' + String((e && (e as any).message) || e))
    }

    // Unified Host call: the dynamic-plugin Client half talks to the host via
    // the harness RPC global (`host.call`); the official bundled Client half
    // (plugin/client.js, no harness global) talks to the same-origin
    // webServer HTTP endpoints registered by the Host half (/save-money/*).
    const callHost = async (method: string, args?: any): Promise<any> => {
      if (typeof host !== 'undefined' && host && typeof host.call === 'function') {
        return host.call(method, args)
      }
      const res = await fetch('/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: args === undefined ? undefined : JSON.stringify(args),
      })
      if (!res.ok) throw new Error('save-money http ' + res.status)
      return res.json()
    }

    // Detect the browser timezone, fall back to Beijing time
    let detectedTz = 'Asia/Shanghai'
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (tz && typeof tz === 'string' && tz.length > 0) detectedTz = tz
    } catch (e) { /* fall back to Beijing time */ }

    // Client UI bound to the shared deps: the reactive translator reads
    // currentLang at call time, so UI text follows the persisted language.
    const ui = createUi({ t: translate, detectedTz, DSHButton })

    let snapshot: any = { enabled: false, state: 'NORMAL', reason: null, window: null, minutesToPause: null, endWindowUntil: null, pauseRecord: null, config: null, balance: null, goUsage: null }
    // Last successful balance fetch (ms) — the balance is refreshed on user
    // messages or every 5 minutes, not on every 30s poll.
    let lastBalanceAt = 0
    // Backoff gate (ms epoch): after a balance failure/timeout we wait this
    // long before trying again, so a failing upstream is never hammered every
    // 30s (and a hung host call can never wedge the refresh loop).
    let nextBalanceAttemptAt = 0
    const BALANCE_RETRY_MS = 5 * 60 * 1000
    // Browser-side hard timeout for one balance call, driven by the cordis
    // timer service (the sandbox has no setTimeout global). A stuck host
    // balance handler must fail this side quickly instead of wedging refresh.
    const balanceWithTimeout = (p: Promise<any>, ms: number, message: string): Promise<any> => {
      const timeoutP = timer.timeout(ms).then(() => { throw new Error(message) })
      return Promise.race([p, timeoutP])
    }
    const refresh = async () => {
      let dirty = false
      try {
        const s = await callHost('save-money/status')
        if (s && typeof s === 'object') {
          // /status doesn't carry balance/goUsage — carry both across polls or
          // they'd vanish on a refresh that skips the balance endpoint.
          const prevBalance = snapshot.balance
          const prevGoUsage = snapshot.goUsage
          snapshot = s
          snapshot.balance = prevBalance
          snapshot.goUsage = prevGoUsage
          dirty = s.balanceDirty === true
          // Keep the UI language in sync with the persisted config choice
          if (s.config && typeof s.config.lang === 'string') currentLang = resolveLang(s.config.lang)
        }
      } catch (e: any) {
        console.error('[save-money] status poll failed: ' + String((e && e.message) || e))
      }
      // Balance updates: on user messages (host sets balanceDirty when a
      // llm/stream request arrives) or every 5 minutes — not on every poll.
      // The host also gates the endpoint when the display is off.
      const BALANCE_MS = 5 * 60 * 1000
      const nowMs = Date.now()
      const due = (!lastBalanceAt || nowMs - lastBalanceAt > BALANCE_MS) && nowMs >= nextBalanceAttemptAt
      const showBal = !!(snapshot.config && snapshot.config.showBalance === true)
      const showGo = !!(snapshot.config && snapshot.config.showOpenCodeGo === true)
      if ((showBal || showGo) && (dirty || due)) {
        try {
          const b = await balanceWithTimeout(callHost('save-money/balance'), 4000, 'balance call timeout')
          // Only a successful response counts as "fetched": a failure keeps the
          // previous value (or null) and leaves lastBalanceAt stale, so the next
          // poll retries instead of waiting 5 minutes for the next refresh.
          // ok:true covers any enabled sub-source (DeepSeek balance OR OpenCode
          // Go usage), so the OpenCode Go usage survives a DeepSeek failure.
          if (b && typeof b === 'object' && b.ok === true) {
            snapshot.balance = b
            snapshot.goUsage = b.goUsage || null
            lastBalanceAt = Date.now()
          } else {
            // Non-ok or unreachable: back off so a failing upstream is not
            // retried every 30s poll.
            nextBalanceAttemptAt = Date.now() + BALANCE_RETRY_MS
          }
        } catch (e: any) {
          console.error('[save-money] balance fetch failed: ' + String((e && (e as any).message) || e))
          nextBalanceAttemptAt = Date.now() + BALANCE_RETRY_MS
        }
      } else if (!showBal && !showGo) {
        snapshot.balance = null
        snapshot.goUsage = null
        // Re-enabling the display must fetch immediately, not wait for the next
        // 5-minute or message-driven refresh: reset the staleness marker here,
        // otherwise `due` stays false and the balance never reappears.
        lastBalanceAt = 0
        nextBalanceAttemptAt = 0
      }
    }
    void refresh()
    // Polling happens per mounted component (useSnap below, 30s) — the header
    // entry is always mounted, so the snapshot stays fresh without an extra
    // apply-level interval (which would double/triple the status traffic).

    // useSnap returns [st, setSt]: components can refresh manually (button
    // clicks reflect the new state immediately)
    const useSnap = () => {
      const [st, setSt] = React.useState({ ...snapshot })
      React.useEffect(() => {
        let alive = true
        const tick = async () => { await refresh(); if (alive) setSt({ ...snapshot }) }
        void tick()
        const stop = timer.interval(() => { void tick() }, 30000)
        return () => { alive = false; stop() }
      }, [])
      return [st, setSt]
    }

    // Per-registration actions: doConfigure = RPC + immediate refresh.
    // A failed configure (e.g. the harness restarted and the RPC is gone) must
    // not leave the UI frozen on stale state: we still refresh + re-render so
    // the checkbox reflects what the host actually persisted, and log the error
    // instead of silently swallowing it.
    const makeActions = (setSt: any) => ({
      doConfigure: async (patch: any) => {
        try {
          await callHost('save-money/configure', patch)
        } catch (e: any) {
          console.error('[save-money] configure failed: ' + String((e && e.message) || e))
        }
        try { await refresh() } catch (e) {}
        setSt({ ...snapshot })
      },
      doEndWindow: async () => {
        try {
          await callHost('save-money/end-window')
        } catch (e: any) {
          console.error('[save-money] end-window failed: ' + String((e && e.message) || e))
        }
        try { await refresh() } catch (e) {}
        setSt({ ...snapshot })
      },
    })

    // ---- Main UI: session-header right-aligned area (status text + balance
    //      + popovers + floating banner; rendered by src/ui/header.tsx) ----
    slots.inject('conversation.session.header.utilities', () => slots.register(
      { name: 'conversation.session.header.utilities', id: 'save-money-status-text', order: 5 },
      () => {
        const [st, setSt] = useSnap()
        const actions = makeActions(setSt)
        // The header entry owns its popovers (settings, bar chart, balance
        // card); refresh is passed in so opening the chart forces a fresh
        // balance sample (the host 5-min sampler does not push updates).
        return React.createElement(ui.HeaderEntry, {
          st,
          actions,
          onRefresh: () => { void refresh() },
        })
      }
    ))

    // ---- System settings page (settings.section, kept) ----
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'save-money', order: 25, label: translate('sectionLabel') },
      () => {
        const [st, setSt] = useSnap()
        const actions = makeActions(setSt)
        return React.createElement('div', { style: { padding: '12px' } },
          React.createElement('h3', { style: { margin: '0 0 12px', fontSize: '15px' } }, translate('settingsHeading')),
          React.createElement(ui.SettingsView, { st, ...actions }),
        )
      }
    ))
  },
}
