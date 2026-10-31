import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type React from 'react'
import type { Map as MLMap } from 'maplibre-gl'
import type { FeatureCollection, LineString } from 'geojson'
import { ChatCircleTextIcon, InfoIcon, PathIcon, CaretUpIcon, CaretDownIcon, StackIcon, UsersIcon, WheelchairIcon, EyeIcon, FunnelIcon } from '@phosphor-icons/react'
import MapView, { riskLetter, type BarrierIcon, FAMILY_LABEL, FAMILY_OF, MAP_COLORS, type Family, type FlyTarget, type Layers, type Scheme } from './MapView.tsx'
import { api, ApiError, getJSON } from './api.ts'
import { BarrierBadge } from './Badge.tsx'
import { CATEGORIES, CAT, type Category, type Cluster, type ReportRow } from './categories.ts'
import {
  affects, applyCorrections, breaks, decodePolyline, distToLine, metresBetween, hotspots, riskAreas, routeAccuracy, sortGaps, type BlockRoute, type Hotspot,
  type Feedback, type Gap, type IndexData, type LngLat, type Route, type Seg, type SegInfo, type SortMode, type Verdict, type VisionEntry,
} from './logic.ts'
import {
  About, BackButton, ClusterDetail, CloseButton, ReportList, clusterScore, clusterTitle, type Range, DrawPanel, GapDetail, GapList, HotspotDetail, HotspotList, RetryError, RiskDetail, RouteDetail, RouteList, SegmentDetail, Skeleton,
  routeTitle, type Likelihood, type RouteSort,
  SORT_LABEL, SortControl, TownPicker, fmt, gapPlace, placeName, short, type SaveState,
} from './Panels.tsx'

type TownData = { slug: string; segments: FeatureCollection; segs: Map<string, SegInfo>; gaps: Gap[] }
type Sel = { kind: 'gap' | 'segment' | 'hot' | 'risk' | 'route' | 'cluster'; id: string; from?: Sel } | null
type View = 'main' | 'about' | 'draw'

const NONE: never[] = []
const WHO_OPTS = [['all', 'Everyone', UsersIcon], ['mobility', 'Mobility aid', WheelchairIcon], ['sight', 'Low vision', EyeIcon]] as const
const WHO_HELP = { mobility: 'Walking frames, wheelchairs, frailty', sight: 'Blind or partially sighted' }
type ListMode = 'hot' | 'fixes' | 'routes' | 'reports'
type Who = 'all' | 'mobility' | 'sight'
// #ang-mo-kio/fixes/mobility: town, list view, who-for filter. Shareable.
const HASH = decodeURIComponent(location.hash.slice(1)).split('/')
const MODES: ListMode[] = ['hot', 'fixes', 'routes', 'reports']
const WHOS: Who[] = ['all', 'mobility', 'sight']
// One health check per page load; town data waits on it so a dead /api costs a single failed request.
// Resolves to null when /api is up, else the error (backup copy or down).
let health: Promise<unknown> | null = null
const apiUp = () => (health ??= api.health().then(h => (h.ok ? null : new Error('down')), e => e))
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

  const [slug, setSlug] = useState<string | null>(() => HASH[0] || null)
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
  const [listMode, setListMode] = useState<ListMode>(() => (MODES.includes(HASH[1] as ListMode) ? HASH[1] as ListMode : 'hot'))
  // Block-to-place routes: loaded only when the Routes view opens (about 2 MB per town).
  const [townRoutes, setTownRoutes] = useState<BlockRoute[] | null | 'error'>(null)
  const [routeSort, setRouteSort] = useState<RouteSort>('likely')
  const [families, setFamilies] = useState<Set<Family>>(() => new Set(Object.keys(FAMILY_LABEL) as Family[]))
  const [blk, setBlk] = useState('')
  const [segDrawn, setSegDrawn] = useState(false)
  const [whoOpen, setWhoOpen] = useState(false)
  // The list never waits on the map for more than 3 s after the data is in (WebGL can be slow or missing).
  useEffect(() => { if (!town || segDrawn) return; const t = setTimeout(() => setSegDrawn(true), 3000); return () => clearTimeout(t) }, [town, segDrawn])
  // Resident reports (Reports view): fetched when the view opens and every 60 s while it stays open.
  const [clusters, setClusters] = useState<Cluster[] | null | 'error'>(null)
  const [reportRows, setReportRows] = useState<ReportRow[]>([])
  const [range, setRange] = useState<Range>('30')
  const [cats, setCats] = useState<Set<Category>>(() => new Set(CATEGORIES.map(c => c.key)))
  const [who, setWho] = useState<Who>(() => (WHOS.includes(HASH[2] as Who) ? HASH[2] as Who : 'all'))
  const [view, setView] = useState<View>('main')
  const [draft, setDraft] = useState<LngLat[]>([])
  const [dest, setDest] = useState('')
  const [savingRoute, setSavingRoute] = useState(false)
  const [routeMsg, setRouteMsg] = useState<string | null>(null)
  const [layers, setLayers] = useState<Layers>({ footfall: true, barriers: false, blocks: false, destinations: false, routes: false, risk: true, icons: true })
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
    apiUp().then(err => (err ? noteApiFailure(err) : setSaveState('ok')))
  }, [noteApiFailure])
  useEffect(() => {
    history.replaceState(null, '', slug ? `#${slug}/${listMode}/${who}` : location.pathname + location.search)
  }, [slug, listMode, who])

  useEffect(() => {
    setIndexErr(false)
    getJSON<IndexData>('/data/index.json').then(setIndex, () => setIndexErr(true))
    getJSON<FeatureCollection>('/data/subzones.json').then(setSubzones, () => {})
    getJSON<Gap[]>('/data/top-gaps.json').then(setTopGaps, () => {})
  }, [indexTry])

  const summary = index?.towns.find(t => t.slug === slug) ?? null
  const firstFrame = useRef(!!HASH[0])
  // Opened with #town in the URL: frame that town once the index arrives.
  useEffect(() => { if (summary && !fly) setFly({ bbox: summary.bbox, n: 0 }) }, [index])

  // Lazy-load only the selected town's files.
  useEffect(() => {
    setTown(null); setBlocks(null); setDests(null); setFeedback([]); setRoutes([]); setVision(undefined); setTownRoutes(null); setBlk(''); setSegDrawn(false); setClusters(null); setReportRows([]); setTownErr(false); setSaveError(null)
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
      if (firstFrame.current) {
        firstFrame.current = false
        // Frame the busier half of the paths (median from the data itself; the index may not have arrived yet).
        const feet = [...segs.values()].map(x => x.foot).sort((a, b) => a - b)
        const p50 = feet[Math.floor(feet.length / 2)] ?? 0
        const busy = [...segs.values()].filter(x => x.foot >= p50).flatMap(x => x.coords)
        if (busy.length) setFly({ bbox: bboxOf(busy), n: 0 })
      }
      const pg = pendingGap.current
      pendingGap.current = null
      const g = pg && gaps.find(x => x.id === pg)
      if (g) select({ kind: 'gap', id: g.id }, g.segs.flatMap(s => segs.get(s)?.coords ?? []))
    }, () => live && setTownErr(true))
    getJSON<FeatureCollection>(`${base}/blocks.json`).then(d => live && setBlocks(d), () => {})
    getJSON<FeatureCollection>(`${base}/destinations.json`).then(d => live && setDests(d), () => {})
    apiUp().then(err => {
      if (err || !live) return
      api.feedback(slug).then(d => live && setFeedback(d), noteApiFailure)
      api.routes(slug).then(d => live && setRoutes(d), noteApiFailure)
    })
    return () => { live = false }
  }, [slug, townTry])

  const padding = mobile
    // The sheet sits at its peek while browsing, and at half height while something is selected.
    ? { top: 64, right: 16, bottom: sheetOpen ? Math.round(innerHeight * 0.56) + 24 : 124, left: 16 }
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
  // "Who for" keeps only barriers that affect that group, then re-ranks.
  const forWho = useCallback((gs: Gap[]) => (index ? gs.filter(g => affects(index.barriers, g.barrier, who)) : gs), [index, who])
  const visibleGaps = useMemo(() => forWho(corrected?.gaps ?? []), [corrected, forWho])
  const ranked = useMemo(() => sortGaps(visibleGaps, sort), [visibleGaps, sort])
  const rankedTop = useMemo(() => sortGaps(forWho(topGaps), sort), [topGaps, sort, forWho])
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
  useEffect(() => {
    if (listMode !== 'routes' || !slug || townRoutes !== null) return
    let live = true
    getJSON<BlockRoute[]>(`/data/towns/${slug}/routes.json`)
      // Newer data ships `path` (encoded polyline) instead of `coords`; accept both.
      .then(rs => rs.map(r => (r.coords ? r : { ...r, coords: decodePolyline(r.path ?? '') })).filter(r => r.coords.length > 1))
      .then(r => live && setTownRoutes(r), () => live && setTownRoutes('error'))
    return () => { live = false }
  }, [listMode, slug, townRoutes])
  const routeList = Array.isArray(townRoutes) ? townRoutes : NONE
  const filteredRoutes = useMemo(() => {
    const b = blk.trim().toLowerCase()
    const out = routeList.filter(r => families.has(FAMILY_OF[r.type] ?? 'shops') && (!b || r.blk.toLowerCase() === b || r.blk.toLowerCase().startsWith(b + ' ')))
    // routes.json is already sorted by trips, most first.
    return routeSort === 'unlikely' ? out.reverse() : routeSort === 'short' ? out.sort((a, b2) => a.len - b2.len) : out
  }, [routeList, families, blk, routeSort])
  const tripCuts = useMemo(() => {
    const v = routeList.map(r => r.trips).sort((a, b) => a - b)
    return [v[Math.floor(v.length * 0.25)] ?? 0, v[Math.floor(v.length * 0.75)] ?? 0]
  }, [routeList])
  const likelihood = (r: BlockRoute): Likelihood => (r.trips >= tripCuts[1] ? 'High' : r.trips >= tripCuts[0] ? 'Medium' : 'Low')
  const typeLabel = (t: string) => index?.destTypes[t]?.label ?? t
  const blockNames = useMemo(() => [...new Set(routeList.map(r => r.blk))].sort(), [routeList])
  const mapRoutes = useMemo(() => (slug && listMode === 'routes'
    ? filteredRoutes.slice(0, 150).map(r => ({ id: String(r.id), coords: r.coords, family: FAMILY_OF[r.type] ?? 'shops' as Family, trips: r.trips }))
    : NONE), [slug, listMode, filteredRoutes])
  const aiPending = Array.isArray(clusters) && clusters.some(c => c.ai_pending)
  useEffect(() => {
    if (listMode !== 'reports' || !slug) return
    let live = true
    const since = range === 'all' ? '' : `&since=${new Date(Date.now() - +range * 86400000).toISOString().slice(0, 10)}`
    const pull = () => {
      getJSON<Cluster[]>(`/api/reports/clusters?town=${encodeURIComponent(slug)}${since}`).then(c => live && setClusters(c), () => live && setClusters(cs => (Array.isArray(cs) ? cs : 'error')))
      getJSON<ReportRow[]>(`/api/reports?town=${encodeURIComponent(slug)}${since}`).then(r => live && setReportRows(r), () => {})
    }
    pull()
    // Every 60 s; every 10 s while Claude is still summarising a cluster.
    const t = setInterval(pull, aiPending ? 10000 : 60000)
    return () => { live = false; clearInterval(t) }
  }, [listMode, slug, range, aiPending])
  const shownClusters = useMemo(() => (Array.isArray(clusters) ? clusters : NONE as Cluster[])
    .filter(c => Object.keys(c.categories).some(k => cats.has(k as Category) && (who === 'all' || (CAT[k as Category]?.profiles ?? ['mobility', 'sight']).includes(who))))
    .sort((a, b) => clusterScore(b) - clusterScore(a)), [clusters, cats, who])
  const mapClusters = useMemo(() => (slug && listMode === 'reports' ? shownClusters.map(c => ({ id: c.id, at: [c.lng, c.lat] as LngLat, count: c.count })) : NONE), [slug, listMode, shownClusters])
  const risks = useMemo(() => riskAreas(slug ? visibleGaps : rankedTop), [slug, visibleGaps, rankedTop])
  const townNames = useMemo(() => Object.fromEntries((index?.towns ?? []).map(t => [t.slug, t.name])), [index])

  // Node -> segments, for walking the connected busy path around a short gap.
  const byNode = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const sg of town?.segs.values() ?? []) for (const n of sg.id.split('-').slice(0, 2)) { if (!m.has(n)) m.set(n, []); m.get(n)!.push(sg.id) }
    return m
  }, [town])
  /** For gaps under 40 m: the connected footP50+ path within 150 m, so a 7 m stair reads in place. */
  const contextOf = useCallback((g: Gap): string[] => {
    if (!town || !footP || g.len >= 40) return NONE
    const seen = new Set(g.segs), queue = [...g.segs], out: string[] = []
    while (queue.length) {
      const id = queue.pop()!
      for (const n of id.split('-').slice(0, 2)) for (const nb of byNode.get(n) ?? []) {
        if (seen.has(nb)) continue
        seen.add(nb)
        const sg = town.segs.get(nb)!
        if (sg.foot < footP[0] || metresBetween(sg.mid, g.at) > 150) continue
        out.push(nb); queue.push(nb)
      }
    }
    return out
  }, [town, footP, byNode])
  const pickGap = (g: Gap) => {
    if (g.town !== slug) {
      pendingGap.current = g.id
      pickTown(g.town)
      return
    }
    const segs = town?.segs
    if (mobile) setSheetOpen(true)
    select({ kind: 'gap', id: g.id }, segs ? [...g.segs, ...contextOf(g)].flatMap(s => segs.get(s)?.coords ?? []) : [g.at])
  }
  const pickHot = (h: Hotspot) => {
    if (mobile) setSheetOpen(true)
    select({ kind: 'hot', id: h.id }, h.segs.flatMap(s => town?.segs.get(s)?.coords ?? []))
  }
  const pickRisk = (id: string) => {
    const r = risks.find(x => x.id === id)
    if (!r) return
    if (mobile) setSheetOpen(true)
    const k = r.radiusM / 110540
    select({ kind: 'risk', id }, [[r.center[0] - k, r.center[1] - k], [r.center[0] + k, r.center[1] + k]])
  }
  const pickCluster = (c: Cluster) => {
    if (mobile) setSheetOpen(true)
    const pts = reportRows.filter(r => c.report_ids.includes(r.id)).map(r => [r.lng, r.lat] as LngLat)
    select({ kind: 'cluster', id: c.id }, pts.length > 1 ? pts : [[c.lng, c.lat]])
  }
  const pickRoute = (r: BlockRoute) => {
    if (mobile) setSheetOpen(true)
    select({ kind: 'route', id: String(r.id) }, r.coords)
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
  const selRisk = sel?.kind === 'risk' ? risks.find(r => r.id === sel.id) ?? null : null
  const selCluster = sel?.kind === 'cluster' ? shownClusters.find(c => c.id === sel.id) ?? null : null
  const clusterReports = useMemo(() => (selCluster ? reportRows.filter(r => selCluster.report_ids.includes(r.id)) : NONE as ReportRow[]), [selCluster, reportRows])
  const rdots = useMemo(() => clusterReports.map(r => [r.lng, r.lat] as LngLat), [clusterReports])
  const selRoute = sel?.kind === 'route' ? routeList.find(r => String(r.id) === sel.id) ?? null : null
  // Barrier icons on the paths: every visible (filtered, corrected) gap; long ones repeat along their segments.
  const bicons = useMemo<BarrierIcon[]>(() => (!town || !index ? NONE : visibleGaps.map(g => ({
    id: g.id, barrier: g.barrier, severity: g.severity, planned: !!g.planned, score: g.foot * g.severity,
    label: `${g.label}, ${gapPlace(g)}`, at: g.at,
    lines: g.len > 150 ? g.segs.map(x => town.segs.get(x)?.coords).filter((c): c is LngLat[] => !!c) : null,
  }))), [town, index, visibleGaps])
  const present = useMemo(() => [...new Set(visibleGaps.map(g => g.barrier))], [visibleGaps])
  const selContext = useMemo(() => (selGap ? contextOf(selGap) : NONE), [selGap, contextOf])
  const routeHl = useMemo(() => (selRoute ? { coords: selRoute.coords, from: selRoute.coords[0], label: selRoute.blk } : null), [selRoute])
  // Stable array so the map only re-filters (and pulses) when the selection really changes.
  const highlight = useMemo(() => (selGap ? selGap.segs : selSeg ? [selSeg.id] : selHot ? selHot.segs : selRisk ? selRisk.gaps.flatMap(g => g.segs) : NONE), [selGap, selSeg, selHot, selRisk])
  const mapGaps = slug ? visibleGaps : rankedTop
  // Fetch the town's photo-check results the first time a segment is opened.
  useEffect(() => {
    if (!selSeg || !slug || vision !== undefined) return
    getJSON<Record<string, VisionEntry>>(`/data/towns/${slug}/vision.json`).then(setVision, () => setVision(null))
  }, [selSeg, slug, vision])
  const pin = selRoute ? { at: selRoute.coords.at(-1)!, label: `Route ends at ${selRoute.dest}` } : selHot ? { at: selHot.at, label: hotTitle(selHot) } : selGap ? { at: selGap.at, label: `${selGap.label}, ${gapPlace(selGap)}` } : selSeg ? { at: selSeg.mid, label: placeName(selSeg.name) } : null

  // Esc clears the selection (and leaves the explainer).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement).closest?.('select, textarea, input')) return
      setSel(null); setWhoOpen(false)
      setView(v => (v === 'about' ? 'main' : v))
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  const fixesShown = view === 'main' && (!slug || listMode === 'fixes')
  const numbered = useMemo(
    () => (fixesShown ? (slug ? ranked : rankedTop).filter(g => !g.planned).slice(0, 10).map(g => ({ id: g.id, at: g.at, label: `${g.label}, ${gapPlace(g)}`, barrier: g.barrier, severity: g.severity })) : []),
    [fixesShown, slug, ranked, rankedTop])
  const pills = (
    <>
      <div className="filter-pills" role="group" aria-labelledby="who-l">
        {WHO_OPTS.map(([k, l, I]) => (
          <button key={k} type="button" className="filter-pill" aria-pressed={who === k} onClick={() => { setWho(k); setWhoOpen(false) }}><I aria-hidden size={18} />{l}</button>
        ))}
      </div>
      {who !== 'all' && <p className="help">{WHO_HELP[who]}</p>}
    </>
  )
  const picker = index && (mobile ? (
    // Phones: town and filter share one row; the three pills live in a small popover.
    <div className="picker-row">
      <TownPicker towns={index.towns} value={slug} onChange={s => (s ? pickTown(s) : allTowns())} />
      <div className="who-pop">
        <span id="who-l" className="sr-only">Show barriers for</span>
        <button type="button" className="filter-btn" aria-expanded={whoOpen} aria-haspopup="true" onClick={() => setWhoOpen(o => !o)}>
          <FunnelIcon aria-hidden size={18} />{WHO_OPTS.find(o => o[0] === who)![1]}<CaretDownIcon aria-hidden size={16} />
        </button>
        {whoOpen && <div className="popover">{pills}</div>}
      </div>
    </div>
  ) : <>
    <TownPicker towns={index.towns} value={slug} onChange={s => (s ? pickTown(s) : allTowns())} />
    <div className="who">
      <span id="who-l">Show barriers for</span>
      {pills}
    </div>
  </>)

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const rows = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>('.list.gaps > li > .row') ?? [])]
    const i = rows.indexOf(e.target as HTMLButtonElement)
    if (i < 0) return
    e.preventDefault()
    rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus()
  }
  const onListFocus = (e: React.FocusEvent) => {
    const at = (e.target as HTMLElement).dataset?.at
    if (at && e.target.matches(':focus-visible')) setFly({ center: at.split(',').map(Number) as LngLat, zoom: 15, n: Date.now() })
  }

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
            : <p className="empty">Footpath data is still being built. Regions will appear here as they finish.</p>}
        </section>
      </div>
    )
  } else if (townErr) {
    body = <div className="stack">{picker}
      <RetryError onRetry={() => setTownTry(n => n + 1)}>This region's data could not be loaded. It may still be processing.</RetryError></div>
  } else if (!town || !corrected || !segDrawn) {
    body = <div className="stack">{picker}<Skeleton /></div>
  } else if (selCluster) {
    // A modelled barrier of the same kind within 40 m backs the residents up.
    const barrier = selCluster.ai?.barrier && selCluster.ai.barrier !== 'other' ? selCluster.ai.barrier
      : CAT[Object.entries(selCluster.categories).sort((a, b) => b[1] - a[1])[0]?.[0] as Category]?.barrier
    const match = visibleGaps.find(g => g.barrier === barrier && metresBetween(g.at, [selCluster.lng, selCluster.lat]) <= 40) ?? null
    body = <>
      <div className="detail-bar"><span /><CloseButton onClick={() => setSel(null)} /></div>
      <ClusterDetail cluster={selCluster} reports={clusterReports} match={match} onGap={pickGap} />
    </>
  } else if (selRoute) {
    // A route barrier links to a fix when a gap with that barrier sits on the route.
    const near = (b: string) => visibleGaps.find(g => g.barrier === b && distToLine(g.at, selRoute.coords) <= 40) ?? null
    body = <>
      <div className="detail-bar"><span /><CloseButton onClick={() => setSel(null)} /></div>
      <RouteDetail route={selRoute} likelihood={likelihood(selRoute)} typeLabel={typeLabel(selRoute.type)} onGap={pickGap}
        barriers={selRoute.barriers.filter(b => affects(index.barriers, b, who) && index.barriers[b])
          .map(b => ({ key: b, label: index.barriers[b].label, severity: index.barriers[b].severity, gap: near(b) }))} />
    </>
  } else if (selRisk) {
    body = <>
      <div className="detail-bar"><span /><CloseButton onClick={() => setSel(null)} /></div>
      <RiskDetail letter={riskLetter(risks.indexOf(selRisk))} area={selRisk} onPick={pickGap} />
    </>
  } else if (selHot) {
    const ids = new Set(selHot.segs)
    body = <>
      <div className="detail-bar"><span /><CloseButton onClick={() => setSel(null)} /></div>
      <HotspotDetail spot={selHot} title={hotTitle(selHot)} rank={hot.indexOf(selHot) + 1}
        fixes={sortGaps(visibleGaps.filter(g => g.segs.some(x => ids.has(x))), 'impact')} onGap={pickGap} />
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
        <div className="switch switch-3" role="group" aria-label="Show">
          <button type="button" aria-pressed={listMode === 'hot'} onClick={() => setListMode('hot')}>Hotspots</button>
          <button type="button" aria-pressed={listMode === 'fixes'} onClick={() => setListMode('fixes')}>Fixes</button>
          <button type="button" aria-pressed={listMode === 'routes'} onClick={() => setListMode('routes')}>Routes</button>
          <button type="button" aria-pressed={listMode === 'reports'} onClick={() => setListMode('reports')}>Reports</button>
        </div>
        {listMode === 'reports' ? (
          <ReportList
            clusters={shownClusters} loading={clusters === null} error={clusters === 'error'} cats={cats}
            onCat={k => setCats(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })}
            range={range} onRange={setRange} region={summary?.name ?? 'this region'} onPick={pickCluster}
          />
        ) : listMode === 'routes' ? (
          <RouteList
            routes={filteredRoutes} total={filteredRoutes.length} families={families} colors={MAP_COLORS[scheme].family}
            onFamily={f => setFamilies(prev => { const n = new Set(prev); if (n.has(f)) n.delete(f); else n.add(f); return n })}
            sort={routeSort} onSort={setRouteSort} blk={blk} blocks={blockNames} onBlk={setBlk}
            likelihood={likelihood} typeLabel={typeLabel} onPick={pickRoute}
            loading={townRoutes === null} error={townRoutes === 'error'}
          />
        ) : listMode === 'hot' ? (
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

  const topItem: { text: string; open: () => void } | null = sel || view !== 'main' || !slug ? null
    : listMode === 'fixes' && ranked[0] ? { text: `Top fix: ${ranked[0].label}, ${gapPlace(ranked[0]).replace(/^Near/, 'near')}, ~${short(ranked[0].foot)} trips/wk`, open: () => pickGap(ranked[0]) }
      : listMode === 'hot' && hot[0] ? { text: `Busiest: ${hotTitle(hot[0]).replace(/^Near /, '')}, ~${short(hot[0].foot)} trips/wk`, open: () => pickHot(hot[0]) }
        : listMode === 'routes' && filteredRoutes[0] ? { text: `Top route: ${routeTitle(filteredRoutes[0])}`, open: () => pickRoute(filteredRoutes[0]) } : null
  const peekTitle = selCluster ? clusterTitle(selCluster) : selRoute ? routeTitle(selRoute) : selRisk ? `High risk area ${riskLetter(risks.indexOf(selRisk))}` : selHot ? hotTitle(selHot) : view === 'draw' ? `Draw my route: ${draft.length} points` : selGap ? `${selGap.label}, ${gapPlace(selGap).replace(/^Near/, 'near')}` : selSeg ? placeName(selSeg.name) : summary?.name ?? 'Singapore'

  return (
    <div className={`app${view === 'draw' ? ' drawing' : ''}${sheetOpen ? ' sheet-open' : ''}${sel ? ' has-sel' : ''}`}>
      <MapView
        scheme={scheme} reducedMotion={reducedMotion} padding={padding}
        subzones={subzones} subzoneBreaks={subzoneBreaks} town={slug}
        segments={town?.segments ?? null} footBreaks={footBreaks} gaps={mapGaps} pin={pin}
        footP={footP} hotIds={slug ? hotIds : []} numbered={numbered}
        risk={layers.risk && view === 'main' && listMode !== 'routes' && listMode !== 'reports' ? risks : NONE}
        routesMode={!!slug && view === 'main' && listMode === 'routes'}
        troutes={mapRoutes}
        routeHl={routeHl}
        reportsMode={!!slug && view === 'main' && listMode === 'reports'} rclusters={mapClusters} selCluster={selCluster?.id ?? null} rdots={rdots}
        onCluster={id => { const c = shownClusters.find(x => x.id === id); if (c) pickCluster(c) }}
        context={selContext} bicons={bicons} selectedGap={selGap?.id ?? null} ring={selGap && selGap.len < 40 ? selGap.at : null}
        onRisk={pickRisk} onRoute={id => { const r = routeList.find(x => String(x.id) === id); if (r) pickRoute(r) }}
        onBlock={b => { setBlk(b); if (mobile) setSheetOpen(true) }}
        blocks={blocks} destinations={dests} destLabels={Object.fromEntries(Object.entries(index?.destTypes ?? {}).map(([k, d]) => [k, d.label]))}
        routes={routes} draft={view === 'draw' ? draft : null} highlight={highlight} layers={layers} fly={fly}
        onTown={pickTown} onGap={id => { const g = corrected?.gaps.find(x => x.id === id) ?? topGaps.find(x => x.id === id); if (g) pickGap(g) }}
        onSegment={id => pickSegment(id)} onEmpty={() => setSel(null)} onRightDrag={rightDragged} onPoint={addPoint} onMapReady={m => { mapRef.current = m }} onDrawn={() => setSegDrawn(true)}
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
            {mobile && !sheetOpen && topItem
              ? <button type="button" className="peek-btn" onClick={() => { setSheetOpen(true); topItem.open() }}>{topItem.text}</button>
              : <p className="tagline">{mobile && !sheetOpen ? peekTitle : 'Where older residents walk most, and what to fix first. Modelled estimates.'}</p>}
          </div>
          <a className="btn-link how report-link" href="/report"><ChatCircleTextIcon aria-hidden size={20} /><span className="label">Report a problem</span></a>
          <button type="button" className="btn-link how" onClick={() => { setView(v => (v === 'about' ? 'main' : 'about')); setSheetOpen(true) }} aria-pressed={view === 'about'}>
            <InfoIcon aria-hidden size={20} /><span className="label">How this works</span>
          </button>
        </header>
        <div className="panel-body" ref={panelRef} onKeyDown={onListKey} onFocus={onListFocus}>{body}</div>
      </aside>

      <MapKey layers={layers} setLayers={setLayers} scheme={scheme} town={!!slug} present={present} labels={index?.barriers} footBreaks={footBreaks} subzoneBreaks={subzoneBreaks} routesMode={!!slug && listMode === 'routes'} />
    </div>
  )
}

function rangeLabels(br: number[]) {
  if (!br.length) return []
  return [`Under ${fmt(br[0])}`, ...br.slice(0, -1).map((b, i) => `${fmt(b)} to ${fmt(br[i + 1])}`), `${fmt(br.at(-1)!)} or more`]
}

function MapKey({ layers, setLayers, scheme, town, footBreaks, subzoneBreaks, routesMode, present, labels }: {
  layers: Layers; setLayers: (f: (l: Layers) => Layers) => void; scheme: Scheme; town: boolean
  footBreaks: number[]; subzoneBreaks: number[]; routesMode: boolean; present: string[]; labels?: IndexData['barriers']
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
  return (
    <div className="mapkey">
      <details>
        <summary><StackIcon aria-hidden size={20} />Layers</summary>
        <div className="mapkey-body">
          {town ? (
            <>
              {toggle('footfall', 'Senior footfall', { background: `linear-gradient(90deg, ${c.ramp.join(',')})` })}
              {layers.footfall && footBreaks.length > 0 && ramp('Estimated senior trips per week (modelled)', footBreaks)}
              {toggle('risk', 'High risk areas', { background: `${c.risk}33`, border: `2px dashed ${c.risk}`, borderRadius: '50%' })}
              {toggle('icons', 'Barrier icons', { background: 'var(--sev3-bg)', border: '2px solid var(--sev3-fg)', borderRadius: '50%' })}
              {layers.icons && labels && present.length > 0 && (
                <ul className="icon-legend">
                  {present.map(b => <li key={b}><BarrierBadge barrier={b} severity={labels[b]?.severity ?? 1} size={16} />{labels[b]?.label ?? b}</li>)}
                  <li className="muted">Tint shows severity. Grey means already planned.</li>
                </ul>
              )}
              {routesMode && (
                <div className="ramp">
                  <p className="ramp-title">Routes from HDB blocks, by place (wider is more trips)</p>
                  <ul>{(Object.keys(FAMILY_LABEL) as Family[]).map(f => <li key={f}><span className="swatch" style={{ background: c.family[f] }} />{FAMILY_LABEL[f]}</li>)}</ul>
                </div>
              )}
              {toggle('routes', 'Routes drawn by residents', { background: `repeating-linear-gradient(90deg, ${c.route} 0 6px, transparent 6px 10px)`, height: 4 })}
              {toggle('blocks', 'HDB blocks (size shows estimated seniors)', { background: c.block, borderRadius: '50%' })}
              {toggle('destinations', 'Places seniors walk to', { border: `2px solid ${c.dest}`, borderRadius: '50%' })}
            </>
          ) : (
            <>
              {subzoneBreaks.length > 0 && ramp('Estimated residents aged 65+ per subzone', subzoneBreaks)}
              {toggle('risk', 'High risk areas', { background: `${c.risk}33`, border: `2px dashed ${c.risk}`, borderRadius: '50%' })}
              {toggle('barriers', 'Top barriers nationwide', { background: c.barrier, borderRadius: '50%' })}
            </>
          )}
        </div>
      </details>
    </div>
  )
}
