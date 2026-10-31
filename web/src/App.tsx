import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Map as MLMap } from 'maplibre-gl'
import type { FeatureCollection, LineString } from 'geojson'
import { InfoIcon, PathIcon, CaretUpIcon, CaretDownIcon, StackIcon } from '@phosphor-icons/react'
import MapView, { MAP_COLORS, type FlyTarget, type Layers, type Scheme } from './MapView.tsx'
import { api, ApiError, getJSON } from './api.ts'
import {
  applyCorrections, breaks, hotspots, routeAccuracy, sortGaps, type Hotspot,
  type Feedback, type Gap, type IndexData, type LngLat, type Route, type Seg, type SegInfo, type SortMode, type Verdict, type VisionEntry,
} from './logic.ts'
import {
  About, BackButton, CloseButton, DrawPanel, GapDetail, GapList, HotspotDetail, HotspotList, RetryError, SegmentDetail, Skeleton,
  SORT_LABEL, SortControl, TownPicker, fmt, gapPlace, placeName, type SaveState,
} from './Panels.tsx'

type TownData = { slug: string; segments: FeatureCollection; segs: Map<string, SegInfo>; gaps: Gap[] }
type Sel = { kind: 'gap' | 'segment' | 'hot'; id: string; from?: Sel } | null
type View = 'main' | 'about' | 'draw'

const SAVE_FAILED = "Corrections can't be saved right now. This change shows on this device only."

function useMedia(q: string) {
  const [m, setM] = useState(() => matchMedia(q).matches)
  useEffect(() => {
    const mq = matchMedia(q)
    const on = () => setM(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [q])
  return m
}

const bboxOf = (coords: LngLat[]): [number, number, number, number] => {
  const xs = coords.map(c => c[0]), ys = coords.map(c => c[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

export default function App() {
  const scheme: Scheme = useMedia('(prefers-color-scheme: dark)') ? 'dark' : 'light'
  const reducedMotion = useMedia('(prefers-reduced-motion: reduce)')
  const mobile = useMedia('(max-width: 767px)')

  const [index, setIndex] = useState<IndexData | null>(null)
  const [indexErr, setIndexErr] = useState(false)
  const [indexTry, setIndexTry] = useState(0)
  const [subzones, setSubzones] = useState<FeatureCollection | null>(null)
  const [topGaps, setTopGaps] = useState<Gap[]>([])

  const [slug, setSlug] = useState<string | null>(() => decodeURIComponent(location.hash.slice(1)) || null)
  const [town, setTown] = useState<TownData | null>(null)
  const [townErr, setTownErr] = useState(false)
  const [townTry, setTownTry] = useState(0)
  const [blocks, setBlocks] = useState<FeatureCollection | null>(null)
  const [dests, setDests] = useState<FeatureCollection | null>(null)
  const [feedback, setFeedback] = useState<Feedback[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  // Street-image results: undefined = not fetched yet, null = not run for this town.
  const [vision, setVision] = useState<Record<string, VisionEntry> | null | undefined>(undefined)
  const [saveState, setSaveState] = useState<SaveState>('ok')
  const [saveError, setSaveError] = useState<string | null>(null)

  const [sel, setSel] = useState<Sel>(null)
  const pendingGap = useRef<string | null>(null)
  const [sort, setSort] = useState<SortMode>('impact')
  const [listMode, setListMode] = useState<'hot' | 'fixes'>('hot')
  const [view, setView] = useState<View>('main')
  const [draft, setDraft] = useState<LngLat[]>([])
  const [dest, setDest] = useState('')
  const [savingRoute, setSavingRoute] = useState(false)
  const [routeMsg, setRouteMsg] = useState<string | null>(null)
  const [layers, setLayers] = useState<Layers>({ footfall: true, barriers: false, blocks: false, destinations: false, routes: false })
  const [sheetOpen, setSheetOpen] = useState(() => !(matchMedia('(max-width: 767px)').matches && location.hash.length > 1))
  const [fly, setFly] = useState<FlyTarget | null>(null)
  const mapRef = useRef<MLMap | null>(null)
  // One-line hint for mouse users until they have right-dragged once.
  const [panHint, setPanHint] = useState(() => {
    if (!matchMedia('(pointer: fine)').matches) return false
    try { return localStorage.getItem('ss-right-drag') !== '1' } catch { return true }
  })
  const rightDragged = useCallback(() => {
    setPanHint(false)
    try { localStorage.setItem('ss-right-drag', '1') } catch { /* private mode: hint just returns next visit */ }
  }, [])
  const panelRef = useRef<HTMLDivElement>(null)

  // A failed /api call tells us which read-only state we are in.
  const noteApiFailure = useCallback((e: unknown) => setSaveState(e instanceof ApiError && e.backup ? 'backup' : 'down'), [])

  useEffect(() => {
    api.health().then(h => setSaveState(h.ok ? 'ok' : 'down'), noteApiFailure)
  }, [noteApiFailure])

  useEffect(() => {
    setIndexErr(false)
    getJSON<IndexData>('/data/index.json').then(setIndex, () => setIndexErr(true))
    getJSON<FeatureCollection>('/data/subzones.json').then(setSubzones, () => {})
    getJSON<Gap[]>('/data/top-gaps.json').then(setTopGaps, () => {})
  }, [indexTry])

  const summary = index?.towns.find(t => t.slug === slug) ?? null
  // Opened with #town in the URL: frame that town once the index arrives.
  useEffect(() => { if (summary && !fly) setFly({ bbox: summary.bbox, n: 0 }) }, [index])

  // Lazy-load only the selected town's files.
  useEffect(() => {
    history.replaceState(null, '', slug ? `#${slug}` : location.pathname + location.search)
    setTown(null); setBlocks(null); setDests(null); setFeedback([]); setRoutes([]); setVision(undefined); setTownErr(false); setSaveError(null)
    if (!slug) return
    let live = true
    const base = `/data/towns/${slug}`
    Promise.all([getJSON<FeatureCollection<LineString, Seg>>(`${base}/segments.json`), getJSON<Gap[]>(`${base}/gaps.json`)]).then(([fc, gaps]) => {
      if (!live) return
      const segs = new Map<string, SegInfo>()
      for (const f of fc.features) {
        const coords = f.geometry.coordinates as LngLat[]
        segs.set(f.properties.id, { ...f.properties, coords, mid: coords[Math.floor(coords.length / 2)] })
      }
      setTown({ slug, segments: fc, segs, gaps })
      const pg = pendingGap.current
      pendingGap.current = null
      const g = pg && gaps.find(x => x.id === pg)
      if (g) select({ kind: 'gap', id: g.id }, g.segs.flatMap(s => segs.get(s)?.coords ?? []))
    }, () => live && setTownErr(true))
    getJSON<FeatureCollection>(`${base}/blocks.json`).then(d => live && setBlocks(d), () => {})
    getJSON<FeatureCollection>(`${base}/destinations.json`).then(d => live && setDests(d), () => {})
    api.feedback(slug).then(d => live && setFeedback(d), noteApiFailure)
    api.routes(slug).then(d => live && setRoutes(d), noteApiFailure)
    return () => { live = false }
  }, [slug, townTry])

  const padding = mobile
    // The sheet sits at its peek while browsing, and at half height while something is selected.
    ? { top: 80, right: 40, bottom: sheetOpen ? Math.round(innerHeight * 0.5) + 32 : 140, left: 40 }
    : { top: 80, right: 80, bottom: 80, left: 496 }

  const pickTown = (s: string) => {
    const t = index?.towns.find(x => x.slug === s)
    if (!t) return
    setSel(null); setView('main'); setDraft([])
    setSlug(s)
    if (mobile) setSheetOpen(false)
    setFly({ bbox: t.bbox, n: Date.now() })
  }
  const allTowns = () => {
    setSlug(null); setSel(null); setView('main'); setDraft([])
    setFly({ bbox: [103.6, 1.2, 104.05, 1.475], n: Date.now() })
  }

  const select = (s: Sel, coords?: LngLat[]) => {
    setSel(s); setView('main'); setSaveError(null)
    if (coords?.length) setFly(coords.length > 1 ? { bbox: bboxOf(coords), n: Date.now() } : { center: coords[0], n: Date.now() })
    panelRef.current?.scrollTo({ top: 0 })
  }

  const corrected = useMemo(
    () => (town && index ? applyCorrections(town.segs, town.gaps, feedback, index.barriers) : null),
    [town, feedback, index])
  const ranked = useMemo(() => sortGaps(corrected?.gaps ?? [], sort), [corrected, sort])
  const rankedTop = useMemo(() => sortGaps(topGaps, sort), [topGaps, sort])
  const footBreaks = useMemo(() => breaks(town ? [...town.segs.values()].map(s => s.foot) : [], [0.5, 0.75, 0.9, 0.97]), [town])
  const subzoneBreaks = useMemo(() => breaks((subzones?.features ?? []).map(f => Number(f.properties?.seniors ?? 0)).filter(n => n > 0), [0.2, 0.4, 0.6, 0.8]), [subzones])
  const accuracy = useMemo(() => (town && summary ? routeAccuracy(routes, town.segs.values(), summary.footP50) : null), [town, routes, summary])
  // Town footfall cut-offs: below p50 fades on the map, p75 and up is a hotspot.
  const footP = useMemo<[number, number] | null>(() => {
    if (!town || !summary) return null
    const v = [...town.segs.values()].map(s => s.foot).sort((a, b) => a - b)
    return [summary.footP50, summary.footP75 ?? v[Math.floor(v.length * 0.75)] ?? 0]
  }, [town, summary])
  const hotTitle = useCallback((h: Hotspot) => {
    if (h.name) return h.name
    // Most paths are unnamed: borrow the nearest block (gap "near" labels first, then blocks.json).
    const d = (a: LngLat) => Math.hypot((a[0] - h.at[0]) * Math.cos(h.at[1] * Math.PI / 180), a[1] - h.at[1]) * 111320
    let best: [number, string] | null = null
    for (const g of town?.gaps ?? []) if (g.near && (!best || d(g.at) < best[0])) best = [d(g.at), g.near]
    for (const f of blocks?.features ?? []) {
      const at = (f.geometry as GeoJSON.Point).coordinates as LngLat
      if (!best || d(at) < best[0]) best = [d(at), `Blk ${f.properties?.blk} ${f.properties?.street}`]
    }
    return best && best[0] < 300 ? `Near ${best[1]}` : 'Unnamed path'
  }, [town, blocks])
  // Stretches that share a title (same street or nearest block) are one place to a reader: merge them.
  const hot = useMemo(() => {
    const out: Hotspot[] = []
    const seen = new Map<string, Hotspot>()
    for (const h of town && footP ? hotspots(town.segs.values(), footP[1], 30) : []) {
      const t = hotTitle(h), prev = seen.get(t)
      if (prev) { prev.segs.push(...h.segs); prev.len += h.len; continue }
      const copy = { ...h, segs: [...h.segs] }
      seen.set(t, copy); out.push(copy)
    }
    return out.slice(0, 10)
  }, [town, footP, hotTitle])
  const hotIds = useMemo(() => hot.flatMap(h => h.segs), [hot])
  const townNames = useMemo(() => Object.fromEntries((index?.towns ?? []).map(t => [t.slug, t.name])), [index])

  const pickGap = (g: Gap) => {
    if (g.town !== slug) {
      pendingGap.current = g.id
      pickTown(g.town)
      return
    }
    const segs = town?.segs
    if (mobile) setSheetOpen(true)
    select({ kind: 'gap', id: g.id }, segs ? g.segs.flatMap(s => segs.get(s)?.coords ?? []) : [g.at])
  }
  const pickHot = (h: Hotspot) => {
    if (mobile) setSheetOpen(true)
    select({ kind: 'hot', id: h.id }, h.segs.flatMap(s => town?.segs.get(s)?.coords ?? []))
  }
  const pickSegment = (id: string, from?: Sel) => {
    const s = town?.segs.get(id)
    if (!s) return
    select({ kind: 'segment', id, from: from ?? undefined }, from ? s.coords : undefined)
    if (mobile) setSheetOpen(true)
  }

  const sendCorrection = (row: { segment: string; gap?: string; barrier?: string; verdict: Verdict; note?: string }) => {
    if (!slug) return
    const local: Feedback = {
      town: slug, segment: row.segment, gap: row.gap ?? null, barrier: row.barrier ?? null, verdict: row.verdict,
      note: row.note || null, created: new Date().toISOString(),
    }
    setFeedback(f => [...f, local]) // applies immediately and re-ranks
    setSaveError(null)
    if (saveState === 'backup') return // what-if only while the backup copy is serving
    api.sendFeedback({ town: slug, ...row, note: row.note || undefined }).then(() => setSaveState('ok'), e => {
      noteApiFailure(e)
      if (!(e instanceof ApiError && e.backup)) setSaveError(SAVE_FAILED)
    })
  }

  const saveRoute = () => {
    if (!slug || draft.length < 2) return
    setSavingRoute(true); setRouteMsg(null)
    const coords = draft.slice(0, 500)
    api.sendRoute({ town: slug, coords, destination_type: dest || undefined }).then(r => {
      setRoutes(rs => [...rs, { ...r, coords: r.coords ?? coords }])
      setDraft([]); setDest(''); setView('main'); setSaveState('ok')
    }, e => {
      noteApiFailure(e)
      if (!(e instanceof ApiError && e.backup)) setRouteMsg("Your route can't be saved right now. Your points are kept, so you can try again.")
    }).finally(() => setSavingRoute(false))
  }

  const addPoint = (p: LngLat) => setDraft(d => (d.length >= 500 ? d : [...d, p]))

  // What is highlighted on the map.
  const selGap = sel?.kind === 'gap' ? (corrected?.gaps.find(g => g.id === sel.id) ?? town?.gaps.find(g => g.id === sel.id) ?? null) : null
  const selSeg = sel?.kind === 'segment' ? town?.segs.get(sel.id) ?? null : null
  const selHot = sel?.kind === 'hot' ? hot.find(h => h.id === sel.id) ?? null : null
  const highlight = selGap ? selGap.segs : selSeg ? [selSeg.id] : selHot ? selHot.segs : []
  const mapGaps = slug ? (corrected?.gaps ?? []) : topGaps
  // Fetch the town's photo-check results the first time a segment is opened.
  useEffect(() => {
    if (!selSeg || !slug || vision !== undefined) return
    getJSON<Record<string, VisionEntry>>(`/data/towns/${slug}/vision.json`).then(setVision, () => setVision(null))
  }, [selSeg, slug, vision])
  const pin = selHot ? { at: selHot.at, label: hotTitle(selHot) } : selGap ? { at: selGap.at, label: `${selGap.label}, ${gapPlace(selGap)}` } : selSeg ? { at: selSeg.mid, label: placeName(selSeg.name) } : null

  // Esc clears the selection (and leaves the explainer).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement).closest?.('select, textarea, input')) return
      setSel(null)
      setView(v => (v === 'about' ? 'main' : v))
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  const fixesShown = view === 'main' && (!slug || listMode === 'fixes')
  const numbered = useMemo(
    () => (fixesShown ? (slug ? ranked : rankedTop).slice(0, 10).map(g => ({ id: g.id, at: g.at, label: `${g.label}, ${gapPlace(g)}` })) : []),
    [fixesShown, slug, ranked, rankedTop])
  const picker = index && <TownPicker towns={index.towns} value={slug} onChange={s => (s ? pickTown(s) : allTowns())} />

  /* ---------- panel body ---------- */
  let body: ReactNode
  if (indexErr) {
    body = <RetryError onRetry={() => setIndexTry(n => n + 1)}>The map data isn't ready yet. It is still being built, so please try again in a few minutes.</RetryError>
  } else if (!index) {
    body = <Skeleton />
  } else if (view === 'about') {
    body = <><BackButton onClick={() => setView('main')}>Back</BackButton>
      <About index={index} figures={summary && corrected ? { town: summary, barriers: ranked.length, accuracy, routes: routes.length } : null} /></>
  } else if (view === 'draw' && slug) {
    body = (
      <DrawPanel
        count={draft.length} destTypes={index.destTypes} dest={dest} setDest={setDest}
        saving={savingRoute} saveState={saveState} error={routeMsg}
        onCentre={() => {
          const m = mapRef.current, x = document.querySelector('.crosshair')
          if (!m || !x) return
          const r = x.getBoundingClientRect(), c = m.getContainer().getBoundingClientRect()
          const ll = m.unproject([r.left + r.width / 2 - c.left, r.top + r.height / 2 - c.top])
          addPoint([+ll.lng.toFixed(6), +ll.lat.toFixed(6)])
        }}
        onUndo={() => setDraft(d => d.slice(0, -1))} onClear={() => setDraft([])}
        onSave={saveRoute} onCancel={() => { setView('main'); setDraft([]); setRouteMsg(null) }}
      />
    )
  } else if (!slug) {
    body = (
      <div className="stack">
        {picker}
        <section className="stack-sm" aria-labelledby="fixes-h">
          <div className="list-head"><h2 id="fixes-h">Top fixes in Singapore</h2><SortControl value={sort} onChange={setSort} /></div>
          {index.towns.length
            ? <GapList key="sg" gaps={rankedTop} townNames={townNames} onPick={pickGap} />
            : <p className="empty">Town footpath data is still being built. Towns will appear here as they finish.</p>}
        </section>
      </div>
    )
  } else if (townErr) {
    body = <div className="stack">{picker}
      <RetryError onRetry={() => setTownTry(n => n + 1)}>This town's data could not be loaded. It may still be processing.</RetryError></div>
  } else if (!town || !corrected) {
    body = <div className="stack">{picker}<Skeleton /></div>
  } else if (selHot) {
    const ids = new Set(selHot.segs)
    body = <>
      <div className="detail-bar"><span /><CloseButton onClick={() => setSel(null)} /></div>
      <HotspotDetail spot={selHot} title={hotTitle(selHot)} rank={hot.indexOf(selHot) + 1}
        fixes={sortGaps(corrected.gaps.filter(g => g.segs.some(x => ids.has(x))), 'impact')} onGap={pickGap} />
    </>
  } else if (selGap) {
    const removed = !corrected.gaps.some(g => g.id === selGap.id)
    const rank = ranked.findIndex(g => g.id === selGap.id) + 1
    const v = selGap.segs.map(s => corrected.verdicts.get(`${s}|${selGap.barrier}`)).find(Boolean)
    const segs = selGap.segs.map(s => town.segs.get(s)!).filter(Boolean).sort((a, b) => b.foot - a.foot)
    body = <>
      <div className="detail-bar"><span /><CloseButton onClick={() => setSel(null)} /></div>
      <GapDetail
        key={selGap.id} gap={selGap} onHotspot={!!footP && selGap.foot >= footP[1]} removed={removed} rank={rank} total={ranked.length} sortLabel={SORT_LABEL[sort]} verdict={v}
        segs={segs} index={index}
        onVerdict={verdict => sendCorrection({ segment: selGap.segs[0], gap: selGap.id, barrier: selGap.barrier, verdict })}
        onMissed={(b, note) => segs[0] && sendCorrection({ segment: segs[0].id, barrier: b, verdict: 'missed', note })}
        onSegment={id => pickSegment(id, sel)} saveState={saveState} saveError={saveError}
      /></>
  } else if (selSeg) {
    body = <>
      <div className="detail-bar">
        {sel?.from ? <BackButton onClick={() => setSel(sel.from!)}>Back to barrier</BackButton> : <span />}
        <CloseButton onClick={() => setSel(null)} />
      </div>
      <SegmentDetail
        key={selSeg.id} seg={selSeg} barriers={corrected.barriers.get(selSeg.id) ?? []} index={index}
        photo={vision === undefined ? undefined : vision?.[selSeg.id] ?? null}
        verdictFor={b => corrected.verdicts.get(`${selSeg.id}|${b}`)} saveState={saveState} saveError={saveError}
        onVerdict={(b, verdict) => sendCorrection({ segment: selSeg.id, barrier: b, verdict })}
        onMissed={(b, note) => sendCorrection({ segment: selSeg.id, barrier: b, verdict: 'missed', note })}
      /></>
  } else {
    body = (
      <div className="stack">
        {picker}
        <div className="switch" role="group" aria-label="Show">
          <button type="button" aria-pressed={listMode === 'hot'} onClick={() => setListMode('hot')}>Hotspots</button>
          <button type="button" aria-pressed={listMode === 'fixes'} onClick={() => setListMode('fixes')}>Fixes</button>
        </div>
        {listMode === 'hot' ? (
          <section className="stack-sm" aria-labelledby="hot-h">
            <h2 id="hot-h" className="list-title">Where seniors walk most</h2>
            <HotspotList spots={hot} title={hotTitle} onPick={pickHot} />
          </section>
        ) : (
          <section className="stack-sm" aria-labelledby="fixes-h">
            <div className="list-head"><h2 id="fixes-h">Priority fixes</h2><SortControl value={sort} onChange={setSort} /></div>
            <GapList key={slug} gaps={ranked} onPick={pickGap} />
          </section>
        )}
        <button type="button" className="btn btn-secondary wide" onClick={() => { setView('draw'); setSel(null); setDraft([]); setRouteMsg(null) }}>
          <PathIcon aria-hidden size={20} />Draw my route
        </button>
      </div>
    )
  }

  const peekTitle = selHot ? hotTitle(selHot) : view === 'draw' ? `Draw my route: ${draft.length} points` : selGap ? `${selGap.label}, ${gapPlace(selGap).replace(/^Near/, 'near')}` : selSeg ? placeName(selSeg.name) : summary?.name ?? 'Singapore'

  return (
    <div className={`app${view === 'draw' ? ' drawing' : ''}${sheetOpen ? ' sheet-open' : ''}${sel ? ' has-sel' : ''}`}>
      <MapView
        scheme={scheme} reducedMotion={reducedMotion} padding={padding}
        subzones={subzones} subzoneBreaks={subzoneBreaks} town={slug}
        segments={town?.segments ?? null} footBreaks={footBreaks} gaps={mapGaps} pin={pin}
        footP={footP} hotIds={slug ? hotIds : []} numbered={numbered}
        blocks={blocks} destinations={dests} destLabels={Object.fromEntries(Object.entries(index?.destTypes ?? {}).map(([k, d]) => [k, d.label]))}
        routes={routes} draft={view === 'draw' ? draft : null} highlight={highlight} layers={layers} fly={fly}
        onTown={pickTown} onGap={id => { const g = corrected?.gaps.find(x => x.id === id) ?? topGaps.find(x => x.id === id); if (g) pickGap(g) }}
        onSegment={id => pickSegment(id)} onEmpty={() => setSel(null)} onRightDrag={rightDragged} onPoint={addPoint} onMapReady={m => { mapRef.current = m }}
      />
      {view === 'draw' && <div className="crosshair" aria-hidden />}
      {panHint && <p className="pan-hint">Right-drag to move the map</p>}

      <aside className={`panel${sheetOpen ? ' open' : ''}`} aria-label="SilverSteps">
        <header className="panel-head">
          {mobile && (
            <button type="button" className="sheet-toggle" aria-expanded={sheetOpen} onClick={() => setSheetOpen(o => !o)}>
              {sheetOpen ? <CaretDownIcon aria-hidden size={20} /> : <CaretUpIcon aria-hidden size={20} />}
              <span className="sr-only">{sheetOpen ? 'Show more map' : 'Show details'}</span>
            </button>
          )}
          <div className="brand">
            <h1>SilverSteps</h1>
            <p className="tagline">{mobile && !sheetOpen ? peekTitle : 'Where older residents walk most, and what to fix first. Modelled estimates.'}</p>
          </div>
          <button type="button" className="btn-link how" onClick={() => { setView(v => (v === 'about' ? 'main' : 'about')); setSheetOpen(true) }} aria-pressed={view === 'about'}>
            <InfoIcon aria-hidden size={20} /><span className="label">How this works</span>
          </button>
        </header>
        <div className="panel-body" ref={panelRef}>{body}</div>
      </aside>

      <MapKey layers={layers} setLayers={setLayers} scheme={scheme} town={!!slug} footBreaks={footBreaks} subzoneBreaks={subzoneBreaks} />
    </div>
  )
}

function rangeLabels(br: number[]) {
  if (!br.length) return []
  return [`Under ${fmt(br[0])}`, ...br.slice(0, -1).map((b, i) => `${fmt(b)} to ${fmt(br[i + 1])}`), `${fmt(br.at(-1)!)} or more`]
}

function MapKey({ layers, setLayers, scheme, town, footBreaks, subzoneBreaks }: {
  layers: Layers; setLayers: (f: (l: Layers) => Layers) => void; scheme: Scheme; town: boolean
  footBreaks: number[]; subzoneBreaks: number[]
}) {
  const c = MAP_COLORS[scheme]
  const ramp = (title: string, br: number[]) => (
    <div className="ramp">
      <p className="ramp-title">{title}</p>
      <ul>
        {rangeLabels(br).map((l, i) => <li key={l}><span className="swatch" style={{ background: c.ramp[i] }} />{l}</li>)}
      </ul>
    </div>
  )
  const toggle = (k: keyof Layers, label: string, swatch: CSSProperties) => (
    <label className="toggle">
      <input type="checkbox" checked={layers[k]} onChange={e => setLayers(l => ({ ...l, [k]: e.target.checked }))} />
      <span className="swatch" style={swatch} aria-hidden />
      {label}
    </label>
  )
  const showMini = town ? layers.footfall && footBreaks.length > 0 : subzoneBreaks.length > 0
  return (
    <div className="mapkey">
      <details>
        <summary><StackIcon aria-hidden size={20} />Layers</summary>
        <div className="mapkey-body">
          {town ? (
            <>
              {toggle('footfall', 'Senior footfall', { background: `linear-gradient(90deg, ${c.ramp.join(',')})` })}
              {layers.footfall && footBreaks.length > 0 && ramp('Estimated senior trips per week (modelled)', footBreaks)}
              {toggle('barriers', 'Barriers (larger is more severe)', { background: c.barrier, borderRadius: '50%' })}
              {toggle('routes', 'Routes drawn by residents', { background: `repeating-linear-gradient(90deg, ${c.route} 0 6px, transparent 6px 10px)`, height: 4 })}
              {toggle('blocks', 'HDB blocks (size shows estimated seniors)', { background: c.block, borderRadius: '50%' })}
              {toggle('destinations', 'Places seniors walk to', { border: `2px solid ${c.dest}`, borderRadius: '50%' })}
            </>
          ) : (
            <>
              {subzoneBreaks.length > 0 && ramp('Estimated residents aged 65+ per subzone', subzoneBreaks)}
              {toggle('barriers', 'Top barriers nationwide', { background: c.barrier, borderRadius: '50%' })}
            </>
          )}
        </div>
      </details>
      {showMini && (
        <div className="legend-mini" aria-hidden>
          <span className="legend-cap">{town ? 'Senior trips a week (modelled)' : 'Seniors per subzone (estimate)'}</span>
          <span className="legend-bar" style={{ background: `linear-gradient(90deg, ${c.ramp.join(',')})` }} />
          <span className="legend-ends"><span>Fewer</span><span>More</span></span>
        </div>
      )}
    </div>
  )
}
