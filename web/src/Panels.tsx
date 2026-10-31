import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeftIcon, CameraIcon, ChatCircleTextIcon, CheckIcon, FireIcon, TrafficSignalIcon, XIcon, PlusIcon, ArrowCounterClockwiseIcon, TrashIcon, CrosshairIcon,
  UsersThreeIcon, WarningIcon, ArrowClockwiseIcon,
} from '@phosphor-icons/react'
import { BarrierBadge } from './Badge.tsx'
import { ago, CATEGORIES, catOf, type Category, type Cluster, type ReportRow } from './categories.ts'
import { FAMILY_LABEL, FAMILY_OF, type Family } from './MapView.tsx'
import { sortGaps, type BlockRoute, type RiskArea } from './logic.ts'
import type { BarrierDef, Gap, Hotspot, IndexData, SegInfo, SortMode, TownSummary, Verdict, Effort, VisionEntry } from './logic.ts'

export const fmt = (n: number) => Math.round(n).toLocaleString('en-SG')
/** 23565 -> 23.6k */
export const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '')}k` : fmt(n))
export const metres = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${fmt(m)} m`)
const EFFORT: Record<Effort, string> = { low: 'Low effort', medium: 'Medium effort', high: 'High effort' }
const HW: Record<string, string> = {
  footway: 'Footpath', path: 'Path', pedestrian: 'Pedestrian street', steps: 'Stairs', cycleway: 'Shared path',
  corridor: 'Covered corridor', residential: 'Residential road with no separate footpath',
  service: 'Service road with no separate footpath', living_street: 'Shared street', track: 'Track',
}
export const hwLabel = (hw: string) => HW[hw] ?? hw.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
export const placeName = (name: string | null) => name ?? 'Unnamed path'
/** Most footpaths are unnamed in OSM, so fall back to the nearest block. */
export const gapPlace = (g: Gap) => g.name ?? (g.near ? `Near ${g.near}` : 'Unnamed path')
const SEAT_CAVEAT = 'Seats are often missing from OpenStreetMap, so check on site before ordering any.'
const SEATS = new Set(['rest_gap', 'long_rest_gap'])
// BCA Code 2025 cl. 4.2.4.3: resting areas at most 50 m apart.
const benches = (len: number) => { const n = Math.max(1, Math.ceil(len / 50)); return n === 1 ? 'one seat' : `about ${n} seats, one every 50 m` }
const fixText = (g: Pick<Gap, 'barrier' | 'fix' | 'len' | 'effort'>) =>
  (SEATS.has(g.barrier) ? `${g.fix}: ${benches(g.len)}` : g.fix) + `. ${EFFORT[g.effort]}.`
const sourceOf = (b: string, fromMap: boolean) =>
  !fromMap ? 'Reported by residents' : SEATS.has(b) ? 'OpenStreetMap benches and bus stops (often incomplete)' : 'OpenStreetMap tags'

export type SaveState = 'ok' | 'down' | 'backup'

/** A barrier definition, with a safe stand-in when the data is newer than index.json. */
const defOf = (index: IndexData, b: string): BarrierDef =>
  index.barriers[b] ?? { label: b.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()), severity: 1, fix: 'Check on site', effort: 'medium' }

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'error'; children: ReactNode }) {
  return (
    <p className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <WarningIcon aria-hidden size={20} />
      <span>{children}</span>
    </p>
  )
}

export function SaveNotice({ state }: { state: SaveState }) {
  if (state === 'backup') return <Notice>You're viewing the backup copy. Saving corrections is paused until the main server is back.</Notice>
  if (state === 'down') return <Notice tone="error">Corrections can't be saved right now. Changes you make show on this device only.</Notice>
  return null
}

export function Skeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading region data">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="sk sk-row" />)}
    </div>
  )
}

export function BackButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return <button type="button" className="btn-link back" onClick={onClick}><ArrowLeftIcon aria-hidden size={20} />{children}</button>
}

export function CloseButton({ onClick }: { onClick: () => void }) {
  return <button type="button" className="btn-icon close" onClick={onClick} aria-label="Close details (Esc)"><XIcon aria-hidden size={22} /></button>
}

function ResidentMark() {
  return <span className="resident-mark"><UsersThreeIcon aria-hidden size={18} />Corrected by residents</span>
}

/* ---------- Pickers ---------- */

export function TownPicker({ towns, value, onChange }: { towns: TownSummary[]; value: string | null; onChange: (slug: string | null) => void }) {
  return (
    <div className="field">
      <label htmlFor="town">Region</label>
      <select id="town" value={value ?? ''} onChange={e => onChange(e.target.value || null)}>
        <option value="">All of Singapore</option>
        {[...towns].sort((a, b) => a.name.localeCompare(b.name)).map(t => <option key={t.slug} value={t.slug}>{t.name}</option>)}
      </select>
    </div>
  )
}

export const SORT_LABEL: Record<SortMode, string> = { impact: 'Biggest impact', reported: 'Most reported by residents', seniors: 'Most seniors helped', quick: 'Quick wins' }

export function SortControl({ value, onChange }: { value: SortMode; onChange: (m: SortMode) => void }) {
  return (
    <label className="inline-select">
      <span>Sort by</span>
      <select value={value} onChange={e => onChange(e.target.value as SortMode)}>
        {(Object.keys(SORT_LABEL) as SortMode[]).map(k => <option key={k} value={k}>{SORT_LABEL[k]}</option>)}
      </select>
    </label>
  )
}

/* ---------- Priority list ---------- */

export function GapList({ gaps: all, townNames, onPick, splitPlanned = true, reported }: { gaps: Gap[]; townNames?: Record<string, string>; onPick: (g: Gap) => void; splitPlanned?: boolean; reported?: Map<string, unknown[]> }) {
  const [limit, setLimit] = useState(6)
  const gaps = splitPlanned ? all.filter(g => !g.planned) : all
  const planned = splitPlanned ? all.filter(g => g.planned) : []
  if (!all.length) return <p className="empty">No barriers found on busy paths here. That can also mean OpenStreetMap has little detail for this area.</p>
  return (
    <>
      <ol className="list gaps" aria-label="Priority fixes">
        {gaps.slice(0, limit).map((g, i) => (
          <li key={g.id}>
            <button type="button" className="row gap-row" data-at={g.at.join(',')} onClick={() => onPick(g)} aria-label={`${i + 1}. ${g.label}. ${gapPlace(g)}. Fix: ${g.fix}. About ${fmt(g.foot)} senior trips a week.`}>
              <BarrierBadge barrier={g.barrier} severity={g.severity} rank={i + 1} />
              <span className="gap-body">
                <span className="issue">
                  {g.label}
                  {g.corrected && <UsersThreeIcon className="mark-icon" size={18} aria-label="Corrected by residents" />}
                </span>
                <span className="row-meta">{gapPlace(g)}{townNames ? `, ${townNames[g.town] ?? g.town}` : ''}</span>
                <span className="chips">
                  <span className="chip">Fix: {g.fix}</span>
                  {(reported?.get(g.id)?.length ?? 0) > 0 && (
                    <span className="chip chip-reported"><ChatCircleTextIcon aria-hidden size={14} />{reported!.get(g.id)!.length} resident {reported!.get(g.id)!.length === 1 ? 'report' : 'reports'}</span>
                  )}
                  <span className="chip">~{short(g.foot)} trips/wk</span>
                  {g.planned ? <span className="chip chip-planned">Already planned</span> : <span className="chip chip-quiet">{EFFORT[g.effort]}</span>}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      {gaps.length > limit && (
        <button type="button" className="btn btn-secondary wide" onClick={() => setLimit(l => l + 10)}>
          Show more ({fmt(gaps.length - limit)} left)
        </button>
      )}
      {planned.length > 0 && (
        <details className="disclosure">
          <summary>Already planned ({planned.length})</summary>
          <GapList gaps={planned} townNames={townNames} onPick={onPick} splitPlanned={false} reported={reported} />
        </details>
      )}
    </>
  )
}

/* ---------- Hotspots ---------- */

export function HotspotList({ spots, title, onPick }: { spots: Hotspot[]; title: (h: Hotspot) => string; onPick: (h: Hotspot) => void }) {
  if (!spots.length) return <p className="empty">No busy stretches found in this region's data.</p>
  return (
    <ol className="list gaps" aria-label="Busiest stretches">
      {spots.slice(0, 8).map((h, i) => (
        <li key={h.id}>
          <button type="button" className="row gap-row" data-at={h.at.join(',')} onClick={() => onPick(h)}>
            <span className="rank">{i + 1}</span>
            <span className="gap-body">
              <span className="row-title">{title(h).replace(/^Near /, '')}</span>
              <span className="row-meta">About {fmt(h.foot)} senior trips a week</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  )
}

export function HotspotDetail({ spot, title, rank, fixes, onGap }: {
  spot: Hotspot; title: string; rank: number; fixes: Gap[]; onGap: (g: Gap) => void
}) {
  return (
    <div className="stack">
      <div>
        <h2>{title}</h2>
        <p className="sub">Busy stretch {rank}, {metres(spot.len)} long</p>
      </div>
      <Trips n={spot.foot} />
      <p className="muted">On the busiest part. One of the busiest quarter of paths in this region (modelled).</p>
      <section className="stack-sm" aria-labelledby="hot-fixes">
        <h3 id="hot-fixes">Barriers on this stretch</h3>
        {fixes.length ? (
          <ul className="list">
            {fixes.map(g => (
              <li key={g.id}>
                <button type="button" className="row" onClick={() => onGap(g)}>
                  <span className="row-title">{g.label}</span>
                  <span className="row-meta">{g.fix}. {EFFORT[g.effort]}.</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="muted">None recorded in the map data.</p>}
      </section>
    </div>
  )
}

/* ---------- Shared detail parts ---------- */

function Trips({ n }: { n: number }) {
  return (
    <p className="hero-stat">
      <span className="hero-num">{fmt(n)}</span>
      <span>estimated senior trips a week</span>
    </p>
  )
}

function VerdictButtons({ current, onVerdict, label }: { current: Verdict | undefined; onVerdict: (v: 'correct' | 'wrong') => void; label: string }) {
  return (
    <div className="verdicts" role="group" aria-label={label}>
      <button type="button" className="btn btn-secondary" aria-pressed={current === 'correct' || current === 'missed'} onClick={() => onVerdict('correct')}>
        <CheckIcon aria-hidden size={20} />Correct
      </button>
      <button type="button" className="btn btn-secondary" aria-pressed={current === 'wrong'} onClick={() => onVerdict('wrong')}>
        <XIcon aria-hidden size={20} />Wrong
      </button>
    </div>
  )
}

function Missed({ index, present, saveState, onMissed }: {
  index: IndexData; present: string[]; saveState: SaveState; onMissed: (b: string, note: string) => void
}) {
  const absent = Object.keys(index.barriers).filter(b => !present.includes(b))
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState('')
  const [note, setNote] = useState('')
  if (!open) return (
    <button type="button" className="btn btn-secondary wide" onClick={() => { setOpen(true); setPick(absent[0] ?? '') }}>
      <PlusIcon aria-hidden size={20} />There's a barrier you missed
    </button>
  )
  return (
    <form className="stack-sm missed" onSubmit={e => { e.preventDefault(); if (pick) { onMissed(pick, note.trim()); setOpen(false); setNote('') } }}>
      <div className="field">
        <label htmlFor="missed-type">Type of barrier</label>
        <select id="missed-type" value={pick} onChange={e => setPick(e.target.value)} required>
          {absent.map(b => <option key={b} value={b}>{index.barriers[b].label}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="missed-note">Note (optional)</label>
        <textarea id="missed-note" rows={2} maxLength={500} value={note} onChange={e => setNote(e.target.value)} aria-describedby="missed-help" />
        <span id="missed-help" className="help">Please leave out names and phone numbers. {500 - note.length} characters left.</span>
      </div>
      <div className="actions">
        <button type="submit" className="btn btn-primary">{saveState === 'ok' ? 'Add barrier' : 'Add on this device'}</button>
        <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  )
}

function Unknowns({ keys, index }: { keys: string[]; index: IndexData }) {
  return (
    <div><dt>Needs a field check</dt><dd>{keys.length ? keys.map(u => index.unknown[u] ?? u).join('. ') : 'Nothing flagged'}</dd></div>
  )
}

const CHECKS: [keyof NonNullable<VisionEntry['checklist']>, string][] = [
  ['handrail', 'Handrail'], ['step_edge_contrast', 'Contrasting step edges'],
  ['tactile_paving', 'Tactile paving'], ['ped_signal', 'Pedestrian signal'],
  ['shelter', 'Shelter'], ['bench', 'Bench'], ['steps', 'Steps'], ['ramp', 'Ramp'],
  ['surface_ok', 'Surface in good condition'], ['obstruction', 'Path partly blocked'], ['signage', 'Signage'],
]
const ANSWER = { yes: 'Yes', no: 'No', unknown: 'Unknown' }

/** Street-image check for one segment. `entry` undefined = still loading, null = not run. */
function PhotoCheck({ entry, minConf }: { entry: VisionEntry | null | undefined; minConf: number }) {
  if (entry === undefined) return <div><dt>Street-image check</dt><dd>Loading</dd></div>
  if (!entry) return <div><dt>Street-image check</dt><dd>Not run yet</dd></div>
  if (entry.status === 'no_imagery') return <div><dt>Street-image check</dt><dd>No street photo available here</dd></div>
  if (entry.status !== 'ok') return <div><dt>Street-image check</dt><dd>The photo check could not be completed here</dd></div>
  const c = entry.checklist ?? {}
  const url = entry.pano && `https://www.google.com/maps/@?api=1&map_action=pano&pano=${encodeURIComponent(entry.pano)}${entry.heading != null ? `&heading=${Math.round(entry.heading)}` : ''}`
  return (
    <>
      <div>
        <dt>Street-image check</dt>
        <dd>
          {entry.date ? `Street View photo from ${entry.date}` : 'Street View photo, date unknown'}
          {url && <><br /><a href={url} target="_blank" rel="noopener noreferrer">Open in Google Street View</a></>}
        </dd>
      </div>
      {CHECKS.map(([k, label]) => {
        const v = c[k] as { value: 'yes' | 'no' | 'unknown'; confidence: number } | undefined
        if (!v) return null
        return <div key={k}><dt>{label}</dt><dd>{v.confidence < minConf ? 'Not sure from photo' : `${ANSWER[v.value]} (${Math.round(v.confidence * 100)}% sure)`}</dd></div>
      })}
      {c.notes && <div><dt>Photo notes</dt><dd>{c.notes}</dd></div>}
    </>
  )
}

const XING = { signals: 'Signalised crossing', zebra: 'Zebra crossing', uncontrolled: 'Crossing without signals' }

/** Crossing type plus what matters for people with low vision: tactile paving and an audio signal. */
function CrossingInfo({ seg, barriers }: { seg: SegInfo; barriers: string[] }) {
  if (!seg.xing) return null
  const status = (missing: string, unknown: string) =>
    barriers.includes(missing) ? 'none' : seg.unknown.includes(unknown) ? 'not recorded' : 'recorded'
  return (
    <div className="crossing">
      <TrafficSignalIcon aria-hidden size={22} />
      <div>
        <p className="row-title">{XING[seg.xing]}</p>
        <p className="row-meta">
          Tactile paving: {status('no_tactile', 'tactile')}
          {seg.xing === 'signals' && <>. Audio signal: {status('silent_signal', 'sound')}</>}
        </p>
      </div>
    </div>
  )
}

/* ---------- Gap detail ---------- */

export function GapDetail({ gap, onHotspot, residentReports = 0, onOpenReports, removed, rank, total, sortLabel, verdict, segs, index, onVerdict, onMissed, onSegment, saveState, saveError }: {
  gap: Gap; onHotspot: boolean; residentReports?: number; onOpenReports?: () => void; removed: boolean; rank: number; total: number; sortLabel: string; verdict: Verdict | undefined
  segs: SegInfo[]; index: IndexData; onVerdict: (v: 'correct' | 'wrong') => void; onMissed: (b: string, note: string) => void
  onSegment: (id: string) => void; saveState: SaveState; saveError: string | null
}) {
  const unknown = [...new Set(segs.flatMap(s => s.unknown))]
  return (
    <div className="stack">
      <div className="issue-head">
        <BarrierBadge barrier={gap.barrier} severity={gap.severity} size={26} />
        <div>
          <h2>{gap.label}</h2>
          <p className="sub">{gapPlace(gap)}</p>
        </div>
      </div>
      <div>
        {onHotspot && <span className="tag"><FireIcon aria-hidden size={16} />On a hotspot</span>}
      </div>
      {removed && <Notice>Residents marked this barrier as wrong, so it is no longer in the priority list.</Notice>}
      <Trips n={gap.foot} />
      <p className="fixline"><strong>Fix:</strong> {fixText(gap)}</p>
      <section className="stack-sm" aria-label="Is this barrier really there?">
        <VerdictButtons current={verdict} onVerdict={onVerdict} label="Is this barrier really there?" />
        <Missed index={index} present={[gap.barrier]} saveState={saveState} onMissed={onMissed} />
        <SaveNotice state={saveState} />
        {saveError && <Notice tone="error">{saveError}</Notice>}
      </section>
      {segs[0] && <CrossingInfo seg={segs[0]} barriers={segs[0].barriers} />}
      {SEATS.has(gap.barrier) && <p className="muted">{SEAT_CAVEAT}</p>}
      {gap.planned && (
        <div className="planned">
          <p><strong>Already planned:</strong> {gap.planned.note}</p>
          <p className="muted">Source: {gap.planned.source}</p>
        </div>
      )}
      {gap.sv ? (
        <p className="sv">
          <a href={`https://www.google.com/maps/@?api=1&map_action=pano&pano=${encodeURIComponent(gap.sv.pano)}&heading=${Math.round(gap.sv.heading ?? 0)}&pitch=-10`} target="_blank" rel="noopener noreferrer">
            <CameraIcon aria-hidden size={20} />View in Street View
          </a>
          {gap.sv.date && <span className="muted">photo from {gap.sv.date}</span>}
        </p>
      ) : gap.sv === null ? <p className="muted">No Street View here</p> : null}
      {gap.corrected && !removed && <ResidentMark />}
      {residentReports > 0 && (
        <button type="button" className="row gap-row" onClick={onOpenReports}>
          <span className="badge sev-1" aria-hidden><ChatCircleTextIcon size={20} /></span>
          <span className="gap-body">
            <span className="issue">{residentReports} resident {residentReports === 1 ? 'report' : 'reports'} here</span>
            <span className="row-meta">See what residents said in Reports</span>
          </span>
        </button>
      )}
      <details className="disclosure">
        <summary>Details</summary>
        <dl className="breakdown">
          {!removed && <div><dt>Rank</dt><dd>{rank} of {fmt(total)} by {sortLabel.toLowerCase()}</dd></div>}
          <div><dt>Severity</dt><dd>{gap.severity} of 3</dd></div>
          <div><dt>Length affected</dt><dd>{metres(gap.len)}</dd></div>
          <div><dt>Source</dt><dd>{gap.source}</dd></div>
          {index.barriers[gap.barrier]?.rule && <div><dt>Standard</dt><dd>{index.barriers[gap.barrier].rule}</dd></div>}
          {gap.owner && <div><dt>Likely owner</dt><dd>{gap.owner} (our estimate; check with the Town Council)</dd></div>}
          <Unknowns keys={unknown} index={index} />
          <div><dt>Street-image check</dt><dd>{segs.some(s => s.vision) ? `Photo checked on ${segs.filter(s => s.vision).length} of ${segs.length} sections. Open a section for the results.` : 'Not run yet'}</dd></div>
        </dl>
        {segs.length > 0 && (
          <>
            <h3 className="mini-h">Path sections in this stretch</h3>
            <ul className="list">
              {segs.slice(0, 8).map(s => (
                <li key={s.id}>
                  <button type="button" className="row" onClick={() => onSegment(s.id)}>
                    <span className="row-title">{hwLabel(s.hw)}, {metres(s.len)}</span>
                    <span className="row-meta">{fmt(s.foot)} senior trips a week (estimate)</span>
                  </button>
                </li>
              ))}
            </ul>
            {segs.length > 8 && <p className="sub">And {segs.length - 8} more, all highlighted on the map.</p>}
          </>
        )}
      </details>
    </div>
  )
}

/* ---------- Segment detail ---------- */

export function SegmentDetail({ seg, barriers, verdictFor, index, photo, saveState, saveError, onVerdict, onMissed }: {
  seg: SegInfo; barriers: string[]; verdictFor: (b: string) => Verdict | undefined; index: IndexData
  photo: VisionEntry | null | undefined
  saveState: SaveState; saveError: string | null
  onVerdict: (b: string, v: 'correct' | 'wrong') => void; onMissed: (b: string, note: string) => void
}) {
  // Every barrier the model or residents ever attached stays listed, so a "wrong" one can be put back.
  const shown = [...new Set([...seg.barriers, ...barriers, ...Object.keys(index.barriers).filter(b => verdictFor(b))])]
  return (
    <div className="stack">
      <div>
        <h2>{placeName(seg.name)}</h2>
        <p className="sub">{hwLabel(seg.hw)}</p>
      </div>
      <Trips n={seg.foot} />
      <CrossingInfo seg={seg} barriers={barriers} />
      <SaveNotice state={saveState} />
      {shown.length === 0 && <p className="empty">No barriers recorded here in OpenStreetMap.</p>}
      <ul className="findings">
        {shown.map(b => {
          const d = defOf(index, b)
          const present = barriers.includes(b)
          return (
            <li key={b} className={present ? '' : 'struck'}>
              <div className="finding-head">
                <span className="row-title">{d.label}</span>
                <span className="row-meta">{present ? <>Fix: {fixText({ ...d, barrier: b, len: seg.len })}</> : 'Residents say this is wrong. It no longer counts.'}</span>
                {verdictFor(b) && <ResidentMark />}
              </div>
              <VerdictButtons current={verdictFor(b)} onVerdict={v => onVerdict(b, v)} label={`Is ${d.label} really there?`} />
            </li>
          )
        })}
      </ul>
      <Missed index={index} present={barriers} saveState={saveState} onMissed={onMissed} />
      {saveError && <Notice tone="error">{saveError}</Notice>}
      <details className="disclosure">
        <summary>Details</summary>
        <dl className="breakdown">
          <div><dt>Length</dt><dd>{metres(seg.len)}{seg.covered ? ', covered' : ''}</dd></div>
          {shown.map(b => <div key={b}><dt>{defOf(index, b).label}</dt><dd>Severity {defOf(index, b).severity} of 3. Source: {sourceOf(b, seg.barriers.includes(b))}</dd></div>)}
          <Unknowns keys={seg.unknown} index={index} />
          <PhotoCheck entry={photo} minConf={index.visionMinConfidence ?? 0.6} />
        </dl>
      </details>
    </div>
  )
}

/* ---------- Draw my route ---------- */

export function DrawPanel({ count, destTypes, dest, setDest, saving, saveState, error, onCentre, onUndo, onClear, onSave, onCancel }: {
  count: number; destTypes: IndexData['destTypes']; dest: string; setDest: (d: string) => void
  saving: boolean; saveState: SaveState; error: string | null
  onCentre: () => void; onUndo: () => void; onClear: () => void; onSave: () => void; onCancel: () => void
}) {
  const paused = saveState === 'backup'
  return (
    <div className="stack">
      <div>
        <h2>Draw my route</h2>
        <p className="sub">Tap the map along the way you actually walk. Only the line is kept, never who drew it.</p>
      </div>
      <p className="rankline" aria-live="polite"><strong>{count}</strong> {count === 1 ? 'point' : 'points'}{count < 2 ? '. Add at least 2.' : ''}</p>
      <div className="actions">
        <button type="button" className="btn btn-secondary" onClick={onCentre}><CrosshairIcon aria-hidden size={20} />Add map centre</button>
        <button type="button" className="btn btn-secondary" onClick={onUndo} disabled={!count}><ArrowCounterClockwiseIcon aria-hidden size={20} />Undo</button>
        <button type="button" className="btn btn-secondary" onClick={onClear} disabled={!count}><TrashIcon aria-hidden size={20} />Clear</button>
      </div>
      <div className="field">
        <label htmlFor="dest-type">Where does this route go? (optional)</label>
        <select id="dest-type" value={dest} onChange={e => setDest(e.target.value)}>
          <option value="">Not saying</option>
          {Object.entries(destTypes).map(([k, d]) => <option key={k} value={k}>{d.label}</option>)}
        </select>
      </div>
      {paused && <SaveNotice state={saveState} />}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onSave} disabled={count < 2 || saving || paused}>
          {saving ? 'Saving' : 'Save route'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

/* ---------- How this works ---------- */

export type TownFigures = { town: TownSummary; barriers: number; accuracy: { share: number; lengthM: number } | null; routes: number }

export function About({ index, figures }: { index: IndexData; figures: TownFigures | null }) {
  const p = index.params
  return (
    <div className="stack prose">
      <h2>How this works</h2>
      <p>
        There is no public count of where older people walk, so SilverSteps models it. Every number here is an estimate from
        public data, not a headcount or a tracked trip.
      </p>
      {figures ? (
        <>
          <h3>{figures.town.name} in numbers</h3>
          <dl className="stats">
            <div><dt>Seniors (estimate)</dt><dd>{fmt(figures.town.seniors)}</dd></div>
            <div><dt>Senior trips a week</dt><dd>{fmt(figures.town.weeklyTrips)}</dd></div>
            <div><dt>Barriers to review</dt><dd>{fmt(figures.barriers)}</dd></div>
          </dl>
          <p className="accuracy">
            {figures.accuracy
              ? <><strong>{Math.round(figures.accuracy.share * 100)}%</strong> of resident-drawn routes ({figures.routes} {figures.routes === 1 ? 'route' : 'routes'}, {fmt(figures.accuracy.lengthM)} m) follow paths we modelled as busy.</>
              : 'No resident routes drawn here yet, so the model has not been checked against real walks in this region.'}
          </p>
        </>
      ) : (
        <p>
          About <strong>{fmt(index.totals.seniors)}</strong> residents aged 65 and over live in the regions covered here
          {index.totals.weeklyTrips > 0 && <>, making an estimated <strong>{fmt(index.totals.weeklyTrips)}</strong> walking trips a week</>}.
        </p>
      )}
      <h3>Steps</h3>
      <ol>
        <li>Residents aged 65 and over are spread across HDB blocks in each subzone by number of flats.</li>
        <li>Each senior makes a set number of trips a week to nearby places (table below).</li>
        <li>Trips follow the easiest walking route, where stairs, unsheltered stretches and unsignalised crossings count as longer.
          Adding up the trips on each footpath gives its estimated senior footfall.</li>
        <li>Barriers come from OpenStreetMap tags. Fixes are ranked by estimated trips times barrier severity, and numbered 1, 2, 3 on the map.</li>
        <li>High risk areas, lettered A to E, circle up to five places where several barriers sit within 150 m of each other. They are scored by adding up trips times severity for every barrier inside.</li>
        <li>Residents and planners can mark findings correct or wrong, add missed barriers and draw the routes they really walk.</li>
      </ol>
      <h3>Assumptions</h3>
      <dl className="breakdown">
        <div><dt>Longest trip</dt><dd>{fmt(p.cutoffM)} m of walking effort</dd></div>
        <div><dt>Distance decay</dt><dd>Trips fall off over about {fmt(p.decayM)} m</dd></div>
        <div><dt>Stairs</dt><dd>Count as {p.stepsFactor} times their length</dd></div>
        <div><dt>Sheltered path</dt><dd>Counts as {p.shelterFactor} times its length</dd></div>
        <div><dt>Crossing without signals</dt><dd>Adds {fmt(p.unsignalisedCrossingM)} m</dd></div>
        <div><dt>Rest gap</dt><dd>No seat for over {fmt(p.benchGapM)} m</dd></div>
      </dl>
      <table className="table">
        <caption>Assumed trips per senior per week</caption>
        <thead><tr><th scope="col">Place</th><th scope="col" className="num">Trips a week</th></tr></thead>
        <tbody>
          {Object.entries(index.destTypes).sort((a, b) => b[1].perWeek - a[1].perWeek).map(([k, d]) => (
            <tr key={k}><td>{d.label}</td><td className="num">{d.perWeek}</td></tr>
          ))}
        </tbody>
      </table>
      <h3>Data sources</h3>
      <ul>
        <li>OpenStreetMap: footpaths, stairs, crossings, benches, bus stops, parks</li>
        <li>data.gov.sg: HDB property information and building footprints</li>
        <li>SingStat: residents by planning subzone, June 2025</li>
        <li>Census 2020: dwelling type by subzone</li>
        <li>data.gov.sg: hawker centres, CHAS clinics and eldercare services</li>
        <li>Basemap: OneMap, Singapore Land Authority</li>
        <li>Barrier rules follow BCA's Code on Accessibility in the Built Environment 2025; crossings and traffic signals follow LTA (the Code defers street works to LTA).</li>
      </ul>
      <h3>Limits</h3>
      <ul>
        <li>Footfall is modelled, not counted. Treat it as a guide to where to look first.</li>
        <li>OpenStreetMap detail varies from street to street. A path with no barrier listed may simply be unmapped.</li>
        <li>Shelter and lighting are often not recorded, so they are marked as needing a field check rather than guessed.</li>
        <li>{index.vision === 'done'
          ? `Street photos (${index.visionSource ?? 'Street View'}) were checked by an AI model on the busiest paths only. Answers below ${Math.round((index.visionMinConfidence ?? 0.6) * 100)}% confidence show as "Not sure from photo". Photos can be old.`
          : 'The street-image check has not been run yet.'}</li>
        <li>No one is tracked. Resident routes are anonymous lines with no account or device attached.</li>
        <li>What we can't see: dementia-friendly wayfinding, seat design (backrest, armrests, wheelchair space) and non-slip finishes are HDB practice our data can't detect, so they need a site check.</li>
        <li>Destination weights are our assumptions; HDB guides give none.</li>
      </ul>
      <p className="sub">Data built {new Date(index.built).toLocaleDateString('en-SG', { day: 'numeric', month: 'long', year: 'numeric' })}.</p>
    </div>
  )
}

export function RetryError({ children, onRetry }: { children: ReactNode; onRetry: () => void }) {
  return (
    <div className="stack-sm">
      <Notice tone="error">{children}</Notice>
      <button type="button" className="btn btn-secondary" onClick={onRetry}><ArrowClockwiseIcon aria-hidden size={20} />Try again</button>
    </div>
  )
}

/* ---------- Risk areas ---------- */

export function RiskDetail({ letter, area, onPick }: { letter: string; area: RiskArea; onPick: (g: Gap) => void }) {
  return (
    <div className="stack">
      <div>
        <h2>High risk area {letter}</h2>
        <p className="sub">{area.gaps.length} {area.gaps.length === 1 ? 'barrier' : 'barriers'} close together on busy paths</p>
      </div>
      <p className="muted">Ranked by estimated senior trips times barrier severity, added up across the area (modelled).</p>
      <GapList gaps={sortGaps(area.gaps, 'impact')} onPick={onPick} />
    </div>
  )
}

/* ---------- Block routes ---------- */

export type Likelihood = 'High' | 'Medium' | 'Low'
const blkShort = (blk: string) => blk.split(' ').slice(0, 2).join(' ')
export const destShort = (d: string) => d.match(/\(([^)]+)\)\s*$/)?.[1] ?? d
export const routeTitle = (r: BlockRoute) => `${blkShort(r.blk)} → ${destShort(r.dest)}`

function Pill({ l }: { l: Likelihood }) {
  return <span className={`pill pill-${l.toLowerCase()}`}>{l} likelihood</span>
}

export type RouteSort = 'likely' | 'unlikely' | 'short'

export function RouteList({ routes, total, families, onFamily, colors, sort, onSort, blk, blocks, onBlk, likelihood, typeLabel, onPick, loading, error }: {
  routes: BlockRoute[]; total: number; families: Set<Family>; onFamily: (f: Family) => void; colors: Record<Family, string>
  sort: RouteSort; onSort: (s: RouteSort) => void; blk: string; blocks: string[]; onBlk: (b: string) => void
  likelihood: (r: BlockRoute) => Likelihood; typeLabel: (t: string) => string; onPick: (r: BlockRoute) => void
  loading: boolean; error: boolean
}) {
  const [limit, setLimit] = useState(8)
  return (
    <section className="stack-sm" aria-labelledby="routes-h">
      <div className="list-head">
        <h2 id="routes-h">Walks from home</h2>
        <label className="inline-select">
          <span>Sort by</span>
          <select value={sort} onChange={e => onSort(e.target.value as RouteSort)}>
            <option value="likely">Most likely first</option>
            <option value="unlikely">Least likely first</option>
            <option value="short">Shortest</option>
          </select>
        </label>
      </div>
      <div className="fam-chips" role="group" aria-label="Show routes to">
        {(Object.keys(FAMILY_LABEL) as Family[]).map(f => (
          <button key={f} type="button" className="fam-chip" aria-pressed={families.has(f)} onClick={() => onFamily(f)}>
            <span className="fam-dot" style={{ background: colors[f] }} aria-hidden />{FAMILY_LABEL[f]}
          </button>
        ))}
      </div>
      <div className="field">
        <label htmlFor="blk">HDB block (optional)</label>
        <input id="blk" type="search" list="blk-list" value={blk} onChange={e => onBlk(e.target.value)} autoComplete="off" aria-describedby="blk-help" />
        <datalist id="blk-list">{blocks.map(b => <option key={b} value={b} />)}</datalist>
        <span id="blk-help" className="help">Or click a block on the map.</span>
      </div>
      {loading ? <Skeleton rows={4} /> : error ? <Notice tone="error">Routes for this region aren't ready yet.</Notice> : !routes.length ? (
        <p className="empty">No routes match. Try another block or turn on more place types.</p>
      ) : (
        <>
          <p className="muted">{fmt(total)} routes. The map shows the first 150.</p>
          <ol className="list gaps" aria-label="Routes">
            {routes.slice(0, limit).map(r => (
              <li key={r.id}>
                <button type="button" className="row route-row" data-at={r.coords[0].join(',')} onClick={() => onPick(r)}>
                  <span className="fam-bar" style={{ background: colors[FAMILY_OF[r.type] ?? 'shops'] }} aria-hidden />
                  <span className="gap-body">
                    <span className="issue">{routeTitle(r)}</span>
                    <span className="row-meta">{typeLabel(r.type)}, {metres(r.len)}, ~{short(r.trips)} trips a week</span>
                    <span className="chips"><Pill l={likelihood(r)} /></span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {routes.length > limit && (
            <button type="button" className="btn btn-secondary wide" onClick={() => setLimit(l => l + 10)}>Show more ({fmt(routes.length - limit)} left)</button>
          )}
        </>
      )}
    </section>
  )
}

export function RouteDetail({ route, likelihood, typeLabel, barriers, onGap }: {
  route: BlockRoute; likelihood: Likelihood; typeLabel: string
  barriers: { key: string; label: string; severity: number; gap: Gap | null }[]; onGap: (g: Gap) => void
}) {
  return (
    <div className="stack">
      <div>
        <h2>{routeTitle(route)}</h2>
        <p className="sub">From {route.blk} to {destShort(route.dest)}, {typeLabel.toLowerCase()}</p>
        <span className="chips"><Pill l={likelihood} /></span>
      </div>
      <Trips n={route.trips} />
      <p className="muted">
        {metres(route.len)} on the shortest walking route. Seniors in this block are estimated to make about {Math.round(route.share * 100)}% of
        their {typeLabel.toLowerCase()} trips to this place.
      </p>
      <section className="stack-sm" aria-labelledby="rb-h">
        <h3 id="rb-h">Barriers on the way</h3>
        {barriers.length ? (
          <ul className="list">
            {barriers.map(b => (
              <li key={b.key}>
                {b.gap ? (
                  <button type="button" className="row gap-row" onClick={() => onGap(b.gap!)}>
                    <BarrierBadge barrier={b.key} severity={b.severity} />
                    <span className="gap-body"><span className="issue">{b.label}</span><span className="row-meta">Open this fix</span></span>
                  </button>
                ) : (
                  <span className="row gap-row static">
                    <BarrierBadge barrier={b.key} severity={b.severity} />
                    <span className="gap-body"><span className="issue">{b.label}</span><span className="row-meta">On a quieter part of the route</span></span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="muted">None recorded in the map data.</p>}
      </section>
    </div>
  )
}

/* ---------- Resident reports ---------- */

export type Range = '7' | '30' | 'all'
export const clusterScore = (c: Cluster) => c.count * (c.ai?.severity ?? 1)
const topCat = (c: Cluster) => Object.entries(c.categories).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other'
export const clusterTitle = (c: Cluster) => c.ai?.title ?? `${c.count} ${c.count === 1 ? 'report' : 'reports'}: ${catOf(topCat(c)).label}`

export function ReportList({ clusters, loading, error, cats, onCat, range, onRange, region, onPick }: {
  clusters: Cluster[]; loading: boolean; error: boolean; cats: Set<Category>; onCat: (c: Category) => void
  range: Range; onRange: (r: Range) => void; region: string; onPick: (c: Cluster) => void
}) {
  const [limit, setLimit] = useState(8)
  const link = `${location.origin}/report`
  return (
    <section className="stack-sm" aria-labelledby="rep-h">
      <div className="list-head">
        <h2 id="rep-h">Resident reports</h2>
        <label className="inline-select">
          <span>From</span>
          <select value={range} onChange={e => onRange(e.target.value as Range)}>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="all">All time</option>
          </select>
        </label>
      </div>
      <div className="fam-chips" role="group" aria-label="Show reports about">
        {CATEGORIES.map(c => (
          <button key={c.key} type="button" className="fam-chip cat-chip" aria-pressed={cats.has(c.key)} onClick={() => onCat(c.key)}>
            <BarrierBadge barrier={c.barrier} severity={2} size={14} />{c.label}
          </button>
        ))}
      </div>
      {loading ? <Skeleton rows={3} /> : error ? <Notice tone="error">Reports can't be loaded right now. They will refresh in a minute.</Notice> : !clusters.length ? (
        <p className="empty">No reports yet in {region}. Residents can send one at <a href={link}>{link.replace(/^https?:\/\//, '')}</a>.</p>
      ) : (
        <>
          <ol className="list gaps" aria-label="Report clusters">
            {clusters.slice(0, limit).map(c => (
              <li key={c.id}>
                <button type="button" className="row gap-row" data-at={`${c.lng},${c.lat}`} onClick={() => onPick(c)}>
                  <BarrierBadge barrier={c.ai?.barrier && c.ai.barrier !== 'other' ? c.ai.barrier : catOf(topCat(c)).barrier} severity={c.ai?.severity ?? 1} />
                  <span className="gap-body">
                    <span className="issue">{clusterTitle(c)}</span>
                    <span className="row-meta">{c.count} {c.count === 1 ? 'report' : 'reports'}, last {ago(c.last)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {clusters.length > limit && <button type="button" className="btn btn-secondary wide" onClick={() => setLimit(l => l + 10)}>Show more ({clusters.length - limit} left)</button>}
        </>
      )}
    </section>
  )
}

export function ClusterDetail({ cluster, reports, match, onGap }: {
  cluster: Cluster; reports: ReportRow[]; match: Gap | null; onGap: (g: Gap) => void
}) {
  const [big, setBig] = useState<ReportRow | null>(null)
  const dlg = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (big) dlg.current?.showModal() }, [big])
  const photos = reports.filter(r => r.has_photo)
  const dateOf = (iso: string) => new Date(iso).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' })
  const ai = cluster.ai
  return (
    <div className="stack">
      <div className="issue-head">
        <BarrierBadge barrier={ai?.barrier && ai.barrier !== 'other' ? ai.barrier : catOf(topCat(cluster)).barrier} severity={ai?.severity ?? 1} size={26} />
        <div>
          <h2>{clusterTitle(cluster)}</h2>
          <p className="sub">{cluster.count} {cluster.count === 1 ? 'report' : 'reports'} from residents, {ago(cluster.first)} to {ago(cluster.last)}</p>
        </div>
      </div>
      {cluster.ai_pending && !ai ? (
        <p className="muted" role="status">Summarising {cluster.count} {cluster.count === 1 ? 'report' : 'reports'}…</p>
      ) : ai ? (
        <div className="ai-box">
          <p className="ai-label">AI summary of {cluster.count} resident {cluster.count === 1 ? 'report' : 'reports'}</p>
          <p>{ai.summary}</p>
          <p><strong>Suggested fix:</strong> {ai.suggested_fix}</p>
          <p className="muted">Severity {ai.severity} of 3. Written by an AI model from what residents said; check on site.</p>
        </div>
      ) : <p className="muted">No AI summary yet. The reports are listed below.</p>}
      {match && (
        <button type="button" className="row gap-row" onClick={() => onGap(match)}>
          <BarrierBadge barrier={match.barrier} severity={match.severity} />
          <span className="gap-body"><span className="issue">Matches modelled barrier</span><span className="row-meta">{match.label}, {gapPlace(match)}. Open this fix.</span></span>
        </button>
      )}
      {photos.length > 0 && (
        <div className="thumbs" role="list" aria-label="Photos from residents">
          {photos.map(r => (
            <button key={r.id} type="button" role="listitem" className="thumb" onClick={() => setBig(r)} aria-label={`Open photo: ${catOf(r.category).label}, ${dateOf(r.created)}`}>
              <img src={`/api/reports/${r.id}/photo`} loading="lazy" alt={`${catOf(r.category).label}, ${dateOf(r.created)}`} />
            </button>
          ))}
        </div>
      )}
      <section className="stack-sm" aria-labelledby="rep-list-h">
        <h3 id="rep-list-h">What residents said</h3>
        <ul className="list">
          {reports.map(r => (
            <li key={r.id} className="report-item">
              <span className="row-title">{catOf(r.category).label}</span>
              <span className="row-meta">{dateOf(r.created)}{r.address_hint ? `, ${r.address_hint}` : ''}</span>
              {r.description ? <p>{r.description}</p> : <p className="muted">No description.</p>}
            </li>
          ))}
        </ul>
      </section>
      <dialog ref={dlg} className="lightbox" onClose={() => setBig(null)} aria-label="Photo">
        {big && <img src={`/api/reports/${big.id}/photo`} alt={`${catOf(big.category).label}, ${dateOf(big.created)}`} />}
        <form method="dialog"><button className="btn btn-secondary" autoFocus>Close</button></form>
      </dialog>
    </div>
  )
}
