import { useState, type ReactNode } from 'react'
import {
  ArrowLeftIcon, CameraIcon, CheckIcon, FireIcon, XIcon, PlusIcon, ArrowCounterClockwiseIcon, TrashIcon, CrosshairIcon,
  UsersThreeIcon, WarningIcon, ArrowClockwiseIcon,
} from '@phosphor-icons/react'
import type { Gap, Hotspot, IndexData, SegInfo, SortMode, TownSummary, Verdict, Effort, VisionEntry } from './logic.ts'

export const fmt = (n: number) => Math.round(n).toLocaleString('en-SG')
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
const BENCH_CAVEAT = 'Bench records are often incomplete, so check on site.'
const benches = (len: number) => { const n = Math.max(1, Math.ceil(len / 200)); return n === 1 ? 'one bench' : `about ${n} benches at 200 m spacing` }
const fixText = (g: Pick<Gap, 'barrier' | 'fix' | 'len' | 'effort'>) =>
  (g.barrier === 'rest_gap' ? `${g.fix}: ${benches(g.len)}` : g.fix) + `. ${EFFORT[g.effort]}.`
const sourceOf = (b: string, fromMap: boolean) =>
  !fromMap ? 'Reported by residents' : b === 'rest_gap' ? 'OpenStreetMap benches and bus stops (often incomplete)' : 'OpenStreetMap tags'

export type SaveState = 'ok' | 'down' | 'backup'

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
    <div className="skeleton" aria-busy="true" aria-label="Loading town data">
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
      <label htmlFor="town">Town</label>
      <select id="town" value={value ?? ''} onChange={e => onChange(e.target.value || null)}>
        <option value="">All of Singapore</option>
        {[...towns].sort((a, b) => a.name.localeCompare(b.name)).map(t => <option key={t.slug} value={t.slug}>{t.name}</option>)}
      </select>
    </div>
  )
}

export const SORT_LABEL: Record<SortMode, string> = { impact: 'Biggest impact', seniors: 'Most seniors helped', quick: 'Quick wins' }

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

export function GapList({ gaps, townNames, onPick }: { gaps: Gap[]; townNames?: Record<string, string>; onPick: (g: Gap) => void }) {
  const [limit, setLimit] = useState(6)
  if (!gaps.length) return <p className="empty">No barriers found on busy paths here. That can also mean OpenStreetMap has little detail for this area.</p>
  return (
    <>
      <ol className="list gaps" aria-label="Priority fixes">
        {gaps.slice(0, limit).map((g, i) => (
          <li key={g.id}>
            <button type="button" className="row gap-row" onClick={() => onPick(g)}>
              <span className="rank">{i + 1}</span>
              <span className="gap-body">
                <span className="row-title">
                  {gapPlace(g)}{townNames ? `, ${townNames[g.town] ?? g.town}` : ''}
                  {g.corrected && <UsersThreeIcon className="mark-icon" size={18} aria-label="Corrected by residents" />}
                </span>
                <span className="row-meta">{g.label}, {fmt(g.foot)} senior trips a week</span>
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
    </>
  )
}

/* ---------- Hotspots ---------- */

export function HotspotList({ spots, title, onPick }: { spots: Hotspot[]; title: (h: Hotspot) => string; onPick: (h: Hotspot) => void }) {
  if (!spots.length) return <p className="empty">No busy stretches found in this town's data.</p>
  return (
    <ol className="list gaps" aria-label="Busiest stretches">
      {spots.slice(0, 8).map((h, i) => (
        <li key={h.id}>
          <button type="button" className="row gap-row" onClick={() => onPick(h)}>
            <span className="rank">{i + 1}</span>
            <span className="gap-body">
              <span className="row-title">{title(h)}</span>
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
      <p className="muted">On the busiest part. One of the busiest quarter of paths in this town (modelled).</p>
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

/* ---------- Gap detail ---------- */

export function GapDetail({ gap, onHotspot, removed, rank, total, sortLabel, verdict, segs, index, onVerdict, onMissed, onSegment, saveState, saveError }: {
  gap: Gap; onHotspot: boolean; removed: boolean; rank: number; total: number; sortLabel: string; verdict: Verdict | undefined
  segs: SegInfo[]; index: IndexData; onVerdict: (v: 'correct' | 'wrong') => void; onMissed: (b: string, note: string) => void
  onSegment: (id: string) => void; saveState: SaveState; saveError: string | null
}) {
  const unknown = [...new Set(segs.flatMap(s => s.unknown))]
  return (
    <div className="stack">
      <div>
        <h2>{gap.label}</h2>
        <p className="sub">{gapPlace(gap)}</p>
        {onHotspot && <span className="tag"><FireIcon aria-hidden size={16} />On a hotspot</span>}
      </div>
      {removed && <Notice>Residents marked this barrier as wrong, so it is no longer in the priority list.</Notice>}
      <Trips n={gap.foot} />
      <p className="fixline"><strong>Fix:</strong> {fixText(gap)}</p>
      {gap.sv ? (
        <p className="sv">
          <a href={`https://www.google.com/maps/@?api=1&map_action=pano&pano=${encodeURIComponent(gap.sv.pano)}&heading=${Math.round(gap.sv.heading ?? 0)}&pitch=-10`} target="_blank" rel="noopener noreferrer">
            <CameraIcon aria-hidden size={20} />View in Street View
          </a>
          {gap.sv.date && <span className="muted">photo from {gap.sv.date}</span>}
        </p>
      ) : gap.sv === null ? <p className="muted">No Street View here</p> : null}
      {gap.corrected && !removed && <ResidentMark />}
      <section className="stack-sm" aria-label="Is this barrier really there?">
        <SaveNotice state={saveState} />
        <VerdictButtons current={verdict} onVerdict={onVerdict} label="Is this barrier really there?" />
        <Missed index={index} present={[gap.barrier]} saveState={saveState} onMissed={onMissed} />
        {saveError && <Notice tone="error">{saveError}</Notice>}
      </section>
      <details className="disclosure">
        <summary>Details</summary>
        <dl className="breakdown">
          {!removed && <div><dt>Rank</dt><dd>{rank} of {fmt(total)} by {sortLabel.toLowerCase()}</dd></div>}
          <div><dt>Severity</dt><dd>{gap.severity} of 3</dd></div>
          <div><dt>Length affected</dt><dd>{metres(gap.len)}</dd></div>
          <div><dt>Source</dt><dd>{gap.source}{gap.barrier === 'rest_gap' ? `. ${BENCH_CAVEAT}` : ''}</dd></div>
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
      <SaveNotice state={saveState} />
      {shown.length === 0 && <p className="empty">No barriers recorded here in OpenStreetMap.</p>}
      <ul className="findings">
        {shown.map(b => {
          const d = index.barriers[b]
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
          {shown.map(b => <div key={b}><dt>{index.barriers[b].label}</dt><dd>Severity {index.barriers[b].severity} of 3. Source: {sourceOf(b, seg.barriers.includes(b))}</dd></div>)}
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
              : 'No resident routes drawn here yet, so the model has not been checked against real walks in this town.'}
          </p>
        </>
      ) : (
        <p>
          About <strong>{fmt(index.totals.seniors)}</strong> residents aged 65 and over live in HDB towns
          {index.totals.weeklyTrips > 0 && <>, making an estimated <strong>{fmt(index.totals.weeklyTrips)}</strong> walking trips a week</>}.
        </p>
      )}
      <h3>Steps</h3>
      <ol>
        <li>Residents aged 65 and over are spread across HDB blocks in each subzone by number of flats.</li>
        <li>Each senior makes a set number of trips a week to nearby places (table below).</li>
        <li>Trips follow the easiest walking route, where stairs, unsheltered stretches and unsignalised crossings count as longer.
          Adding up the trips on each footpath gives its estimated senior footfall.</li>
        <li>Barriers come from OpenStreetMap tags. Fixes are ranked by estimated trips times barrier severity.</li>
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
