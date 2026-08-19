/**
 * dsh-save-money — i18n types (locale keys + language identifiers).
 *
 * Split out of src/client.ts so each locale dictionary lives in its own file
 * (i18n/zh.ts, i18n/en.ts, …) — the standard per-locale layout. The dict
 * contents are user-facing translations; everything else in the codebase uses
 * English comments per project convention.
 */

export type Lang = 'zh' | 'zh-TW' | 'en' | 'de' | 'fr' | 'es' | 'it' | 'pt' | 'ja' | 'ko'

export interface Dict {
  badgeDisabled: string
  badgePaused: string
  badgeWarn: string
  badgeWorking: string
  bannerPaused: string
  bannerAutoResume: string
  bannerWarn: string
  bannerMinutes: string
  bannerMoment: string
  endThisWindow: string
  endWindowActive: string
  statusPrefix: string
  windowSuffix: string
  pausedNote: string
  deepseekPreset: string
  presetExists: string
  presetUpgraded: string
  presetAdded: string
  applyFailed: string
  savedMsg: string
  enable: string
  timezone: string
  language: string
  langAuto: string
  langZh: string
  langZhTw: string
  langEn: string
  langDe: string
  langFr: string
  langEs: string
  langIt: string
  langPt: string
  langJa: string
  langKo: string
  windowsTitle: string
  pause: string
  resume: string
  removeTitle: string
  addWindow: string
  save: string
  settingsTitle: string
  headerTitle: string
  badgeLabel: string
  sectionLabel: string
  settingsHeading: string
  showBalance: string
  // OpenCode Go usage display (v1.5.0). Optional so the non-zh/en locales can
  // omit them and fall back to English via t().
  showOpenCodeGo?: string
  goTitle?: string
  goWindow5h?: string
  goWindowWeek?: string
  goWindowMonth?: string
  goRemaining?: string
  goUsed?: string
  goReset?: string
  goNone?: string
  // Header display-source selector (which provider's data to show).
  displayTitle?: string
  srcAuto?: string
  srcDeepseek?: string
  srcGo?: string
  srcInUse?: string
  srcChart?: string
  modelApplyTitle: string
  modelApplyHint: string
  applyOfficial: string
  applyOpencode: string
  spendH1: string
  spendM10: string
  spendH24: string
  barsTitle: string
  barsHint: string
  barsExternal: string
  barsTopUp: string
  barsDisclaimer: string
}
