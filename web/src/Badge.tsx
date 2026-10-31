import {
  StairsIcon, TrafficSignIcon, SpeakerSlashIcon, ArrowFatLineUpIcon, UmbrellaIcon, ChairIcon, WarningIcon,
  MoonStarsIcon, TrendUpIcon, ProhibitIcon, FootprintsIcon, type Icon,
} from '@phosphor-icons/react'

const ICONS: Record<string, Icon> = {
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
