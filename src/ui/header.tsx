/**
 * dsh-save-money — Client UI: session-header entry (src/ui/header.tsx)
 *
 * The single persistent header entry (next to the Session log): the status
 * text, a single switchable "provider display" chip, the settings popover, the
 * spend bar-chart popover and the floating pause banner. Registered in the
 * conversation.session.header.utilities slot by the client body; this file
 * only renders — data and actions flow in through props.
 *
 * Provider display (the chip): the plugin supports several queryable
 * "display sources" (deepseek-official monetary balance, opencode-go quota
 * windows, ...). Which one is SHOWN follows cfg.displaySource:
 *   - 'auto' (default): follow the provider of the most recent model request,
 *     falling back to the first available source.
 *   - a concrete id: always show that source (when available).
 * Clicking the chip opens a small menu listing every available source so the
 * user can pick which to display; the choice is persisted.
 *
 * Hover cards and the bar-chart tooltip are custom floating cards (fixed +
 * zIndex 10001): native `title` tooltips get clipped at the viewport edge and
 * cannot wrap, so the long text was invisible. Cards follow the mouse and
 * extend LEFT from the cursor (the chip sits at the right edge of the header),
 * clamped so they never leave the viewport.
 */

declare const React: any
declare const window: any
declare const document: any
declare function wallClock(tz: string, date: Date): { y: number; mo: number; d: number; weekday: number; minutes: number }
declare function renderBalanceElement(balance: any, React: any): any | null
declare function balanceDetailLines(balance: any, labels?: { h1: string; m10: string; h24: string }): string[] | null
declare function currencySymbol(currency: string): string

/** Factory: build the HeaderEntry component bound to client deps + UI pieces. */
export function createHeaderEntry(deps: any, subs: any) {
  const t = deps.t
  const detectedTz = deps.detectedTz
  const badgeInfo = deps.badgeInfo
  const { SettingsView, FloatingBanner, BarChart } = subs

  const HeaderEntry = (props: any) => {
    const st = props.st
    const actions = props.actions
    const onRefresh = props.onRefresh || (() => {})
    const [open, setOpen] = React.useState(false)
    const [barsOpen, setBarsOpen] = React.useState(false)
    const [menuOpen, setMenuOpen] = React.useState(false)
    const menuRef = React.useRef(null)
    const chipRef = React.useRef(null)
    // Clicking anywhere OUTSIDE the chip + menu closes the menu — a clear way
    // to "cancel"/dismiss the source selector without changing the selection.
    React.useEffect(() => {
      if (!menuOpen) return
      const onDown = (e: any) => {
        const t = e && e.target
        if ((menuRef.current && menuRef.current.contains(t)) || (chipRef.current && chipRef.current.contains(t))) return
        setMenuOpen(false)
      }
      if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }
    }, [menuOpen])
    // Position of the active source's hover detail card (null = hidden).
    const [tip, setTip] = React.useState(null)
    const updateTip = (e: any) => {
      const vw = typeof window !== 'undefined' && window && typeof window.innerWidth === 'number' ? window.innerWidth : 1024
      const vh = typeof window !== 'undefined' && window && typeof window.innerHeight === 'number' ? window.innerHeight : 768
      const x = typeof e.clientX === 'number' ? e.clientX : vw
      const y = typeof e.clientY === 'number' ? e.clientY : 0
      const right = Math.max(8, Math.min(vw - 8, vw - x + 12))
      const top = Math.max(8, Math.min(y + 14, vh - 200))
      setTip({ right, top })
    }
    const b = badgeInfo(st)
    // "Save" + symbol + status text all use the state color
    const text = React.createElement('span', {
      onClick: () => { setOpen(!open); setMenuOpen(false) },
      style: {
        color: b.color, fontSize: '13px', fontWeight: 700, whiteSpace: 'nowrap',
        padding: '4px 8px', cursor: 'pointer', borderRadius: '6px',
        border: '1px solid ' + b.color, marginRight: '8px',
        pointerEvents: 'auto',
      },
      title: t('headerTitle', { status: b.text }),
    }, t('badgeLabel', { symbol: b.symbol, text: b.text }))

    // ---- Available display sources ----
    const dsEnabled = !!(st.config && st.config.showBalance === true)
    const goEnabled = !!(st.config && st.config.showOpenCodeGo === true)
    const dsOk = !!(st.balance && typeof st.balance === 'object' && st.balance.ok === true
      && Array.isArray(st.balance.balance) && st.balance.balance.length > 0)
    const go = st.goUsage
    const goOk = !!(go && typeof go === 'object' && go.ok === true)
    const balanceEl = dsOk ? renderBalanceElement(st.balance, React) : null

    // OpenCode Go plan-window usage (REMAINING percent per window + resets).
    const remOf = (w: any) => {
      if (w && typeof w.percent === 'number') return Math.max(0, Math.round(100 - w.percent))
      return null
    }
    const GO_WINS = [
      { short: t('goWindow5h'), w: go && go.rolling },
      { short: t('goWindowWeek'), w: go && go.weekly },
      { short: t('goWindowMonth'), w: go && go.monthly },
    ]
    const goText = goOk
      ? 'OpenCode Go ▸ ' + GO_WINS.map((g) => {
          const r = remOf(g.w)
          return g.short + ' ' + (r === null ? '–' : r + '%')
        }).join(' · ')
      : ''
    const goTime = (iso: any, tzShow: string) => {
      try {
        const d = new Date(iso)
        if (isNaN(d.getTime())) return null
        const wc = wallClock(tzShow, d)
        return String(Math.floor(wc.minutes / 60)).padStart(2, '0') + ':' + String(wc.minutes % 60).padStart(2, '0')
      } catch (e) { return null }
    }

    // Ordered list of sources that are BOTH enabled and actually carrying data.
    const available = [
      { id: 'deepseek-official', label: t('srcDeepseek'), on: dsEnabled && dsOk, textEl: balanceEl, go: false },
      { id: 'opencode-go', label: t('srcGo'), on: goEnabled && goOk, textEl: null, go: true },
    ].filter((s) => s.on)

    // Which source to SHOW: the pinned displaySource if available, else the
    // first available. Availability never follows the last-used provider, so
    // the chip doesn't jump between conversations.
    const displaySource = st.config && st.config.displaySource
    let activeId = null
    if (available.length > 0) {
      if (displaySource && displaySource !== 'auto' && available.some((s) => s.id === displaySource)) {
        activeId = displaySource
      } else {
        activeId = available[0].id
      }
    }
    const activeSrc = available.find((s) => s.id === activeId) || null

    // The single header chip: shows the active source's value, click to pick.
    const chipContent = activeSrc
      ? (activeSrc.go
          ? React.createElement('span', { style: { fontSize: '12px', fontWeight: 600 } }, goText)
          : balanceEl)
      : null
    const chip = activeSrc
      ? React.createElement('span', {
          ref: chipRef,
          onClick: (e: any) => {
            e.stopPropagation()
            setTip(null)
            setBarsOpen(false)
            setOpen(false) // don't overlap the settings popover (same anchor)
            setMenuOpen((v: any) => !v)
          },
          onMouseEnter: updateTip,
          onMouseMove: updateTip,
          onMouseLeave: () => setTip(null),
          title: t('displayTitle'),
          style: {
            color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', fontWeight: 600,
            whiteSpace: 'nowrap', marginRight: '8px', cursor: 'pointer', pointerEvents: 'auto',
            padding: '2px 6px', borderRadius: '6px',
            border: '1px solid var(--dsw-alias-border-l1)',
          },
        }, chipContent, React.createElement('span', { style: { marginLeft: '4px', opacity: 0.7 } }, '▾'))
      : null

    // Hover detail card for the ACTIVE source.
    const detailCard = (() => {
      if (!tip || !activeSrc) return null
      if (!activeSrc.go) {
        const lines = balanceDetailLines(st.balance, { h1: t('spendH1'), m10: t('spendM10'), h24: t('spendH24') })
        if (!lines) return null
        const sa = st.balance && st.balance.spendAt
        if (sa && typeof sa.m10 === 'number' && typeof sa.h1 === 'number') {
          try {
            const tzShow = (st.config && typeof st.config.timezone === 'string' && st.config.timezone.length > 0)
              ? st.config.timezone : detectedTz
            const fmt = (tt: number) => {
              const wc = wallClock(tzShow, new Date(tt))
              return String(Math.floor(wc.minutes / 60)).padStart(2, '0') + ':' + String(wc.minutes % 60).padStart(2, '0')
            }
            if (lines.length >= 2) lines[1] += ' ' + fmt(sa.h1) + '–' + fmt(sa.h1 + 60 * 60 * 1000)
            if (lines.length >= 3) lines[2] += ' ' + fmt(sa.m10) + '–' + fmt(sa.m10 + 10 * 60 * 1000)
          } catch (e) { /* keep the unlabelled lines on any tz error */ }
        }
        return React.createElement('div', {
          style: {
            position: 'fixed', right: tip.right, top: tip.top, zIndex: 10001,
            background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
            borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)',
            boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
            padding: '6px 10px', fontSize: '12px', lineHeight: '1.6',
            maxWidth: 'min(340px, calc(100vw - 24px))',
            whiteSpace: 'normal', overflowWrap: 'break-word', pointerEvents: 'none',
          },
        }, lines.map((ln, i) => React.createElement('div', {
          key: i, style: i === 0 ? { fontWeight: 700 } : { color: 'var(--dsw-alias-label-secondary)' },
        }, ln)))
      }
      // OpenCode Go detail
      const tzShow = (st.config && typeof st.config.timezone === 'string' && st.config.timezone.length > 0)
        ? st.config.timezone : detectedTz
      const glines: string[] = [t('goTitle')]
      for (const g of GO_WINS) {
        const r = remOf(g.w)
        let ln = g.short + ' ' + (r === null ? t('goNone') : r + '% ' + t('goRemaining'))
        if (g.w && typeof g.w.percent === 'number') ln += ' (' + Math.round(g.w.percent) + '% ' + t('goUsed') + ')'
        const tm = goTime(g.w && g.w.resetsAt, tzShow)
        if (tm) ln += ' · ' + t('goReset') + ' ' + tm
        glines.push(ln)
      }
      return React.createElement('div', {
        style: {
          position: 'fixed', right: tip.right, top: tip.top, zIndex: 10001,
          background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
          borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)',
          boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
          padding: '6px 10px', fontSize: '12px', lineHeight: '1.6',
          maxWidth: 'min(340px, calc(100vw - 24px))',
          whiteSpace: 'normal', overflowWrap: 'break-word', pointerEvents: 'none',
        },
      }, glines.map((ln, i) => React.createElement('div', {
        key: i, style: i === 0 ? { fontWeight: 700 } : { color: 'var(--dsw-alias-label-secondary)' },
      }, ln)))
    })()

    // Source-selection menu.
    const menu = menuOpen
      ? React.createElement('div', {
          ref: menuRef,
          style: {
            position: 'fixed', right: '16px', top: '56px', width: '340px',
            background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
            borderRadius: '10px', boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
            padding: '6px 8px 8px', zIndex: 10000,
            border: '1px solid var(--dsw-alias-border-l1)', pointerEvents: 'auto',
          },
        },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 6px 2px' } },
            React.createElement('span', { style: { fontSize: '13px', fontWeight: 700 } }, t('displayTitle')),
            React.createElement('button', {
              onClick: () => setMenuOpen(false),
              style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '14px', color: 'var(--dsw-alias-label-secondary)', pointerEvents: 'auto' },
            }, '✕'),
          ),
          // auto + one row per available source
          ([null] as any[]).concat(available).map((src: any, i: number) => {
            const isAuto = src === null
            const key = isAuto ? 'auto' : src.id
            // The checkmark reflects the PINNED config choice (displaySource),
            // so in 'auto' only the "Auto" row is checked — never two at once.
            const selected = isAuto ? (!displaySource || displaySource === 'auto') : (displaySource === src.id)
            const name = isAuto ? t('srcAuto') : src.label
            return React.createElement('div', {
              key,
              onClick: () => {
                // Apply the choice but KEEP the menu open so the checkmark
                // moves visibly instead of the menu vanishing on click.
                void actions.doConfigure({ displaySource: isAuto ? 'auto' : src.id })
              },
              style: {
                display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 8px',
                borderRadius: '6px', cursor: 'pointer', pointerEvents: 'auto',
                background: selected ? 'var(--dsw-alias-bg-layer-1)' : 'transparent',
                fontSize: '13px',
              },
            },
              React.createElement('span', { style: { width: '14px', flexShrink: 0, color: 'var(--dsw-alias-brand-primary)' } },
                selected ? '✓' : ''),
              React.createElement('span', { style: { flex: 1 } }, name),
              !isAuto && src.go
                ? React.createElement('span', {
                    style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis' },
                  }, goText)
                : (!isAuto && !src.go ? balanceEl : null),
            )
          }),
          // DeepSeek spend chart access (only when active = deepseek)
          activeSrc && !activeSrc.go
            ? React.createElement('div', {
                onClick: (e: any) => {
                  e.stopPropagation()
                  setMenuOpen(false)
                  setBarsOpen(true)
                  onRefresh()
                },
                style: {
                  marginTop: '4px', padding: '7px 8px', borderRadius: '6px', cursor: 'pointer',
                  pointerEvents: 'auto', fontSize: '13px', color: 'var(--dsw-alias-label-secondary)',
                  borderTop: '1px solid var(--dsw-alias-border-l1)',
                },
              }, t('srcChart'))
            : null,
        )
      : null

    const pop = open
      ? React.createElement('div', {
          style: {
            position: 'fixed', right: '16px', top: '56px', width: '380px',
            background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
            borderRadius: '10px', boxShadow: '0 6px 24px rgba(0,0,0,0.35)', padding: '4px 8px 8px',
            zIndex: 10000, border: '1px solid var(--dsw-alias-border-l1)', maxHeight: '70vh', overflowY: 'auto',
            pointerEvents: 'auto',
          },
        },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 6px 0' } },
            React.createElement('span', { style: { fontSize: '13px', fontWeight: 700 } }, t('settingsTitle')),
            React.createElement('button', {
              onClick: () => setOpen(false),
              style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '14px', color: 'var(--dsw-alias-label-secondary)', pointerEvents: 'auto' },
            }, '✕'),
          ),
          React.createElement(SettingsView, { st, ...actions }),
        )
      : null
    // Spend bar-chart popup (clicked from the source menu): last 8h per 10 min.
    const chartPopup = barsOpen && balanceEl
      ? React.createElement('div', {
          style: {
            position: 'fixed', right: '16px', top: '56px', width: '420px',
            background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
            borderRadius: '10px', boxShadow: '0 6px 24px rgba(0,0,0,0.35)', padding: '4px 8px 8px',
            zIndex: 10000, border: '1px solid var(--dsw-alias-border-l1)', pointerEvents: 'auto',
          },
        },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 6px 0' } },
            React.createElement('span', { style: { fontSize: '13px', fontWeight: 700 } }, t('barsTitle')),
            React.createElement('button', {
              onClick: () => setBarsOpen(false),
              style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '14px', color: 'var(--dsw-alias-label-secondary)', pointerEvents: 'auto' },
            }, '✕'),
          ),
          React.createElement(BarChart, {
            bars: st.balance && st.balance.bars,
            timezone: st.config && st.config.timezone,
            symbol: (st.balance && st.balance.balance && st.balance.balance[0])
              ? currencySymbol(String(st.balance.balance[0].currency || ''))
              : '¥',
          }),
        )
      : null
    return React.createElement('div', { style: { display: 'contents' } },
      text,
      chip,
      detailCard,
      menu,
      pop,
      chartPopup,
      React.createElement(FloatingBanner, { st, doEndWindow: actions.doEndWindow }),
    )
  }
  return HeaderEntry
}
