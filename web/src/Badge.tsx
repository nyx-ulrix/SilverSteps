import {
  StairsIcon, TrafficSignIcon, SpeakerSlashIcon, ArrowFatLineUpIcon, UmbrellaIcon, ChairIcon, WarningIcon,
  MoonStarsIcon, TrendUpIcon, ProhibitIcon, FootprintsIcon, type Icon,
} from '@phosphor-icons/react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'

export const ICONS: Record<string, Icon> = {
  steps: StairsIcon, crossing: TrafficSignIcon, silent_signal: SpeakerSlashIcon, kerb: ArrowFatLineUpIcon,
  no_shelter: UmbrellaIcon, rest_gap: ChairIcon, surface: WarningIcon, dark: MoonStarsIcon, slope: TrendUpIcon,
  obstruction: ProhibitIcon, no_tactile: FootprintsIcon,
}

/** Barrier icon in a square badge tinted by severity (3 strong, 2 amber, 1 neutral). */
export function BarrierBadge({ barrier, severity, size = 20, rank }: { barrier: string; severity: number; size?: number; rank?: number }) {
  const I = ICONS[barrier] ?? WarningIcon
  return (
    <span className={`badge sev-${Math.min(3, Math.max(1, severity))}`} aria-hidden>
      <I size={size} />
      {rank != null && <span className="badge-rank">{rank}</span>}
    </span>
  )
}

/** Severity tints for map icons, per scheme. Mirrors the --sevN tokens in styles.css; g = greyed out. */
const TINTS = {
  light: { 3: ['#fde4d8', '#a8330c'], 2: ['#fbefcf', '#7d4f00'], 1: ['#e9e9ec', '#4b4b53'], g: ['#e4e4e7', '#a1a1aa'], halo: '#fafafa' },
  dark: { 3: ['#4a2418', '#ffab8a'], 2: ['#43340f', '#f7c968'], 1: ['#33333a', '#d0d0d6'], g: ['#27272a', '#71717a'], halo: '#0b0b0d' },
} as const

/** Phosphor glyph as an SVG string, rendered once through React into a detached node. */
function glyph(barrier: string): string {
  const I = ICONS[barrier] ?? WarningIcon
  const box = document.createElement('div')
  const root = createRoot(box)
  flushSync(() => root.render(<I size={22} />))
  const svg = box.innerHTML
  root.unmount()
  return svg
}

/**
 * Round badge images for every barrier x tint x scheme, named `b-<barrier>-<3|2|1|g>-<scheme>`.
 * Drawn at 2x for crisp 22px icons.
 */
export async function barrierImages(barriers: string[]): Promise<{ name: string; img: HTMLImageElement }[]> {
  const out: Promise<{ name: string; img: HTMLImageElement }>[] = []
  for (const b of barriers) {
    const inner = glyph(b).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')
    for (const scheme of ['light', 'dark'] as const) for (const t of ['3', '2', '1', 'g'] as const) {
      const [bg, fg] = TINTS[scheme][t]
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44">` +
        `<circle cx="22" cy="22" r="19.5" fill="${bg}" stroke="${TINTS[scheme].halo}" stroke-width="4"/>` +
        `<svg x="11" y="11" width="22" height="22" viewBox="0 0 256 256" fill="${fg}" color="${fg}">${inner}</svg></svg>`
      const img = new Image(44, 44)
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
      out.push(img.decode().then(() => ({ name: `b-${b}-${t}-${scheme}`, img })))
    }
  }
  return Promise.all(out)
}
