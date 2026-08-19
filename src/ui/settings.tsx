/**
 * dsh-save-money — Client UI: settings panel (src/ui/settings.tsx)
 *
 * The full settings view shared by the header popover and the system settings
 * page: enable switch, balance display switch, per-model-tier apply
 * checkboxes, timezone picker, language picker, pause-window editor, the
 * one-click DeepSeek preset and a single Save button at the bottom.
 *
 * Inlined into the client plugin body at build time (scripts/build.js): no
 * imports survive; cross-module references (core time helpers, badge) are
 * `declare`d for standalone type-checking and resolve at runtime.
 */

declare const React: any
declare function parseHHMM(s: string): number | null
declare function formatHHMM(m: number): string
declare function convertHHMM(tzFrom: string, tzTo: string, hhmm: number, ref?: Date): number
declare function utcOffsetMinutes(tz: string, date: Date): number
// Client-head bindings (inlined into the same body at build time): the
// reactive language + its resolver live in src/client.ts; PLUGIN_VERSION is
// substituted at build time (scripts/build.js).
declare let currentLang: any
declare function resolveLang(cfgLang: string | undefined | null): any
declare const PLUGIN_VERSION: string

// ---- 24 fixed whole-hour timezones (real timezone rules, DST-aware) ----
// One representative per integer UTC offset (UTC-11 … UTC+12), fixed order.
// The (UTC+X) label is computed live, so DST zones show their current offset
// (e.g. Europe/London (UTC+1) in summer) while the picker stays stable.
interface TzEntry { name: string; off: number }
const ALL_TIMEZONES: TzEntry[] = (() => {
  const ZONES = [
    'Pacific/Pago_Pago', 'Pacific/Honolulu', 'America/Anchorage', 'America/Los_Angeles',
    'America/Denver', 'America/Chicago', 'America/New_York', 'America/Halifax',
    'America/Sao_Paulo', 'Atlantic/South_Georgia', 'Atlantic/Azores', 'UTC',
    'Europe/London', 'Europe/Paris', 'Europe/Athens', 'Europe/Moscow',
    'Asia/Dubai', 'Asia/Karachi', 'Asia/Dhaka', 'Asia/Bangkok',
    'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Brisbane', 'Pacific/Auckland',
  ]
  const now = new Date()
  return ZONES.map((n) => {
    try { return { name: n, off: utcOffsetMinutes(n, now) * 60000 } }
    catch (e) { return { name: n, off: NaN } }
  })
})()
const TZ_OFF = new Map(ALL_TIMEZONES.map((x) => [x.name, x.off] as [string, number]))
const fmtOff = (ms: number): string => {
  const m = ms / 60000
  const sign = m >= 0 ? '+' : '-'
  const a = Math.abs(m)
  const h = Math.floor(a / 60)
  const mm = a % 60
  return 'UTC' + sign + h + (mm > 0 ? ':' + String(mm).padStart(2, '0') : '')
}

/** Factory: build the SettingsView component bound to client deps. */
export function createSettingsView(deps: any) {
  const t = deps.t
  const detectedTz = deps.detectedTz
  const DSHButton = deps.DSHButton
  const badgeInfo = deps.badgeInfo

  const SettingsView = (props: any) => {
    const st = props.st
    const doConfigure = props.doConfigure
    const doEndWindow = props.doEndWindow || (async () => {})
    const cfg = st.config || {}
    const [tz, setTz] = React.useState(cfg.timezone || detectedTz)
    // Default windows shown when none are configured (fresh install / all
    // windows deleted) — matches the one-click DeepSeek preset (2-minute
    // boundary margin): 08:58–12:02, 13:58–18:02.
    const DEFAULT_WINS = [
      { pauseAt: '08:58', resumeAt: '12:02' },
      { pauseAt: '13:58', resumeAt: '18:02' },
    ]
    const [wins, setWins] = React.useState(DEFAULT_WINS.map((w: any) => ({ ...w })))
    const [msg, setMsg] = React.useState('')
    const [langSel, setLangSel] = React.useState(cfg.lang || 'auto')
    const prevWinKey = React.useRef('')
    const prevTz = React.useRef(null)
    const prevLang = React.useRef(null)
    React.useEffect(() => {
      // Sync only when the config actually changed (the 30s poll must not
      // interrupt in-progress edits)
      if (cfg.timezone && cfg.timezone !== prevTz.current) {
        prevTz.current = cfg.timezone
        setTz(cfg.timezone)
      }
      const cl = cfg.lang || 'auto'
      if (cl !== prevLang.current) {
        prevLang.current = cl
        setLangSel(cl)
        currentLang = resolveLang(cl)
      }
      const ws = cfg.windows || []
      const key = JSON.stringify(ws)
      if (key !== prevWinKey.current) {
        prevWinKey.current = key
        setWins(ws.length > 0
          // Carry days / per-window timezone through the row state: the UI
          // only edits pauseAt/resumeAt, but Save must not strip the other
          // fields the user configured.
          ? ws.map((w: any) => ({ pauseAt: w.pauseAt, resumeAt: w.resumeAt, ...(w.days !== undefined ? { days: w.days } : {}), ...(w.timezone !== undefined ? { timezone: w.timezone } : {}) }))
          : DEFAULT_WINS.map((w: any) => ({ ...w })))
      }
    }, [st])
    const row = (label: string, children: any) => React.createElement('div', { style: { margin: '8px 0', display: 'flex', alignItems: 'center', gap: '8px' } },
      React.createElement('span', { style: { minWidth: '80px', fontSize: '13px' } }, label), children)
    const input = (value: string, setter: any, width?: string) => React.createElement('input', {
      value, onChange: (e: any) => setter(e.target.value),
      style: {
        width: width || '72px', padding: '3px 6px', fontSize: '13px',
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '4px',
      },
    })
    const btn = (text: string, fn: any, primary: boolean) => DSHButton
      ? React.createElement(DSHButton, {
          variant: 'outline',
          size: 'sm',
          onClick: fn,
        }, text)
      : React.createElement('button', {
          onClick: fn,
          style: {
            padding: '6px 14px', cursor: 'pointer', fontSize: '13px',
            background: primary ? 'var(--dsw-alias-button-primary-fill)' : 'var(--dsw-alias-bg-layer-2)',
            color: primary ? 'var(--dsw-alias-label-primary-foreground)' : 'var(--dsw-alias-label-primary)',
            border: primary ? 'none' : '1px solid var(--dsw-alias-border-l1)',
            borderRadius: '6px',
          },
        }, text)
    // One compact switch: label + checkbox in a row (used for the enable /
    // balance-display switches that now share one line).
    const switchRow = (label: string, checked: boolean, onChange: (v: boolean) => void) => React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', lineHeight: '16px' } },
      React.createElement('span', { style: { fontSize: '13px' } }, label),
      React.createElement('input', {
        type: 'checkbox', checked,
        onChange: (e: any) => onChange(e.target.checked),
        style: { margin: 0, boxSizing: 'border-box', verticalAlign: 'middle', flexShrink: 0, accentColor: 'var(--dsw-alias-brand-primary)', width: 14, height: 14, cursor: 'pointer' },
      }))
    // One model-tier group row: group label + one checkbox per tier
    // (flash / pro) side by side. The two tier checkboxes are wrapped in a
    // nowrap unit so they always stay on one line together (a lone wrap of
    // "pro" would look misaligned).
    const tierRow = (label: string, prefix: string) => React.createElement('div', { style: { margin: '4px 0', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
      React.createElement('span', { style: { minWidth: '110px', fontSize: '13px' } }, label),
      React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '10px', whiteSpace: 'nowrap' } },
        tierCheck(prefix + '-flash', 'flash'),
        tierCheck(prefix + '-pro', 'pro'),
      ),
    )
    const tierCheck = (key: string, label: string) => React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px', lineHeight: '15px' } },
      React.createElement('span', { style: { fontSize: '12px' } }, label),
      React.createElement('input', {
        type: 'checkbox', checked: !!(cfg.modelApply && cfg.modelApply[key] === true),
        onChange: (e: any) => void doConfigure({ modelApply: { ...cfg.modelApply, [key]: e.target.checked } }),
        style: { margin: 0, boxSizing: 'border-box', verticalAlign: 'middle', flexShrink: 0, accentColor: 'var(--dsw-alias-brand-primary)', width: 14, height: 14, cursor: 'pointer' },
      }))
    // Window add/remove/edit
    const setWin = (i: number, key: string, val: string) => setWins(wins.map((w: any, j: number) => (j === i ? { ...w, [key]: val } : w)))
    const addWin = () => setWins([...wins, { pauseAt: '08:58', resumeAt: '12:02' }])
    const delWin = (i: number) => setWins(wins.filter((_: any, j: number) => j !== i))
    // One-click apply = dedupe-append (does NOT auto-enable; the user checks
    // the Enable box themselves). The DeepSeek preset windows carry a 2-minute
    // boundary margin — pause 2 min early, resume 2 min late
    // (08:58–12:02, 13:58–18:02, avoiding clock-skew requests slipping
    // through or releasing early at peak boundaries).
    const DEEPSEEK_PRESET = [
      { pauseAt: '08:58', resumeAt: '12:02', timezone: 'Asia/Shanghai' },
      { pauseAt: '13:58', resumeAt: '18:02', timezone: 'Asia/Shanghai' },
    ]
    // Legacy DeepSeek windows (no margin) — removed first on one-click so the
    // overlap validation does not reject the new ones.
    const DEEPSEEK_LEGACY = [
      { pauseAt: '09:00', resumeAt: '12:00', timezone: 'Asia/Shanghai' },
      { pauseAt: '14:00', resumeAt: '18:00', timezone: 'Asia/Shanghai' },
    ]
    const applyDeepSeekPreset = async () => {
      try {
        // WYSIWYG: work from the window list the user currently SEES in the
        // UI (wins), not from whatever was last persisted on the host — so
        // edits made but not yet saved are respected.
        const curTz = (st.config && st.config.timezone) || 'Asia/Shanghai'
        const key = (w: any) => String(w.pauseAt) + '|' + String(w.resumeAt) + '|' + (w.timezone || curTz)
        const legacyKeys = new Set(DEEPSEEK_LEGACY.map(key))
        const cleaned = wins.filter((w: any) => !legacyKeys.has(key(w))) // upgrade legacy windows
        const existing = new Set(cleaned.map(key))
        const add = DEEPSEEK_PRESET.filter((p: any) => !existing.has(key(p)))
        if (add.length === 0) {
          setMsg(t('presetExists'))
          return
        }
        const merged = cleaned.concat(add)
        setWins(merged) // reflect the result in the UI immediately
        await doConfigure({ windows: merged }) // windows only, enabled untouched
        const upgraded = wins.length - cleaned.length
        setMsg((upgraded > 0 ? t('presetUpgraded', { n: upgraded }) : '') + t('presetAdded', { n: add.length }))
      } catch (e: any) {
        setMsg(t('applyFailed') + String((e && e.message) || e))
      }
    }
    // Unified Save at the bottom (replaces the old "apply windows" button).
    // Carries days / per-window timezone through; the dropdown timezone only
    // applies to windows without an explicit one.
    const saveAll = () => {
      const clean = wins
        .map((w: any) => ({
          pauseAt: String(w.pauseAt || '').trim(),
          resumeAt: String(w.resumeAt || '').trim(),
          ...(w.days !== undefined ? { days: w.days } : {}),
          ...(w.timezone !== undefined ? { timezone: w.timezone } : { timezone: tz }),
        }))
        .filter((w: any) => w.pauseAt !== '' && w.resumeAt !== '')
      void doConfigure({ windows: clean })
      setMsg(t('savedMsg', { n: clean.length }))
    }
    const b = badgeInfo(st)
    return React.createElement('div', { style: { padding: '12px' } },
      // Top: status text + end-this-window button (kept near the top; shown
      // only when a window is active — WARN or PAUSED)
      React.createElement('div', { style: { margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        React.createElement('span', { style: { fontSize: '13px', fontWeight: 600, color: b.color } },
          t('statusPrefix') + b.text + (st.state === 'PAUSED' && st.window ? t('windowSuffix', { a: st.window.pauseAt, b: st.window.resumeAt }) : '')),
        (st.state === 'WARN' || st.state === 'PAUSED')
          ? btn(t('endThisWindow'), () => void doEndWindow(), st.state === 'PAUSED')
          : null,
        st.state === 'PAUSED' ? React.createElement('div', { style: { margin: '6px 0', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' } }, t('pausedNote')) : null,
      ),
      // Green status line while "end this save mode" is in effect for the
      // current window (in-memory, one-shot): tells the user what happened
      // and how to reset it.
      st.endWindowUntil ? React.createElement('div', { style: { margin: '6px 0 10px', fontSize: '12px', color: 'var(--dsw-alias-state-success-primary)', fontWeight: 600 } },
        t('endWindowActive', { a: st.window ? st.window.pauseAt : '', b: st.window ? st.window.resumeAt : '', c: st.window ? st.window.resumeAt : '' })) : null,
      msg ? React.createElement('div', { style: { margin: '8px 0', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, msg) : null,
      // Enable + balance display share one row (two compact switches).
      React.createElement('div', { style: { margin: '8px 0', display: 'flex', alignItems: 'center', gap: '18px', flexWrap: 'wrap' } },
        switchRow(t('enable'), !!st.enabled, (v: boolean) => void doConfigure({ enabled: v })),
        switchRow(t('showBalance'), !!cfg.showBalance, (v: boolean) => void doConfigure({ showBalance: v })),
        switchRow(t('showOpenCodeGo'), !!cfg.showOpenCodeGo, (v: boolean) => void doConfigure({ showOpenCodeGo: v })),
      ),
      // Model tiers: checked = this tier pauses inside windows; unchecked =
      // exempt. Two rows — official / opencode — each with flash + pro
      // checkboxes side by side. Default is the two official tiers only;
      // after the user edits, the persisted choice is respected.
      // Unrecognized/unsupported models are always exempt.
      React.createElement('div', { style: { margin: '10px 0 2px', fontSize: '13px', fontWeight: 600 } },
        t('modelApplyTitle')),
      tierRow(t('applyOfficial'), 'official'),
      tierRow(t('applyOpencode'), 'opencode'),
      React.createElement('div', { style: { margin: '0 0 8px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
        t('modelApplyHint')),
      row(t('timezone'), React.createElement('select', {
        value: tz,
        onChange: (e: any) => {
          const v = e.target.value
          if (!v || v === tz) return
          const oldTz = tz
          setTz(v)
          // WYSIWYG: convert every window from the old timezone to the new
          // one (real timezone rules, DST-aware; e.g. Beijing 08:58 ->
          // London 01:58 in summer, 00:58 in winter). NOT saved yet — the
          // bottom Save button persists timezone + converted times together.
          setWins(wins.map((w: any) => {
            const p = parseHHMM(String(w.pauseAt))
            const r = parseHHMM(String(w.resumeAt))
            return {
              pauseAt: p === null ? String(w.pauseAt || '') : formatHHMM(convertHHMM(oldTz, v, p)),
              resumeAt: r === null ? String(w.resumeAt || '') : formatHHMM(convertHHMM(oldTz, v, r)),
            }
          }))
        },
        style: {
          padding: '3px 6px', fontSize: '13px', maxWidth: '240px',
          background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
          border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '4px',
        },
      },
        // Current timezone first, then the full IANA list sorted by offset
        // (offset computed with today's rules, so DST zones move correctly).
        [tz].concat(ALL_TIMEZONES.filter((x: TzEntry) => x.name !== tz).map((x: TzEntry) => x.name))
          .map((n: string) => {
            const off = TZ_OFF.get(n)
            return React.createElement('option', { key: n, value: n },
              n + (off !== undefined && !Number.isNaN(off) ? ' (' + fmtOff(off) + ')' : ''))
          }),
      )),
      // Language: auto (follow the browser) by default; manual choices are
      // persisted into the host config (save-money.config.json, `lang` field)
      // so they survive refresh/restart in every plugin form.
      row(t('language'), React.createElement('select', {
        value: langSel,
        onChange: (e: any) => {
          const v = e.target.value
          setLangSel(v)
          currentLang = resolveLang(v)
          void doConfigure({ lang: v })
        },
        style: {
          padding: '3px 6px', fontSize: '13px',
          background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
          border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '4px',
        },
      },
        React.createElement('option', { value: 'auto' }, t('langAuto')),
        React.createElement('option', { value: 'zh' }, t('langZh')),
        React.createElement('option', { value: 'zh-TW' }, t('langZhTw')),
        React.createElement('option', { value: 'en' }, t('langEn')),
        React.createElement('option', { value: 'de' }, t('langDe')),
        React.createElement('option', { value: 'fr' }, t('langFr')),
        React.createElement('option', { value: 'es' }, t('langEs')),
        React.createElement('option', { value: 'it' }, t('langIt')),
        React.createElement('option', { value: 'pt' }, t('langPt')),
        React.createElement('option', { value: 'ja' }, t('langJa')),
        React.createElement('option', { value: 'ko' }, t('langKo')),
      )),
      // One-click DeepSeek preset button: sits right above the window list
      // (it is the windows' quick action)
      React.createElement('div', { style: { margin: '10px 0 4px' } },
        btn(t('deepseekPreset'), () => void applyDeepSeekPreset(), true),
      ),
      React.createElement('div', { style: { marginTop: '4px', fontSize: '13px', fontWeight: 600 } },
        t('windowsTitle', { tz, n: wins.length })),
      wins.map((w: any, i: number) => React.createElement('div', { key: i, style: { margin: '6px 0', display: 'flex', alignItems: 'center', gap: '6px' } },
        React.createElement('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', width: '28px' } }, String(i + 1) + '.'),
        React.createElement('span', { style: { fontSize: '12px' } }, t('pause')),
        input(w.pauseAt, (v: string) => setWin(i, 'pauseAt', v)),
        React.createElement('span', { style: { fontSize: '12px' } }, t('resume')),
        input(w.resumeAt, (v: string) => setWin(i, 'resumeAt', v)),
        React.createElement('button', {
          onClick: () => delWin(i),
          style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '14px', color: 'var(--dsw-alias-state-error-primary)', padding: '2px 4px' },
          title: t('removeTitle'),
        }, '✕'),
      )),
      React.createElement('div', { style: { margin: '8px 0' } },
        btn(t('addWindow'), () => addWin(), false),
      ),
      // Bottom: plugin name + version on the left, unified Save button
      React.createElement('div', { style: { margin: '10px 0 2px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
        React.createElement('span', {
          style: {
            fontSize: '11px', color: 'var(--dsw-alias-label-secondary)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          },
        }, 'save-money v' + PLUGIN_VERSION),
        btn(t('save'), () => saveAll(), true),
      ),
    )
  }
  return SettingsView
}
