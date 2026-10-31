// Pure data logic: types, corrections, ranking, route accuracy. No imports so it runs under plain `node`.

export type LngLat = [number, number]
export type Effort = 'low' | 'medium' | 'high'
export type BarrierDef = { label: string; severity: number; fix: string; effort: Effort }

export type TownSummary = {
  slug: string; name: string; seniors: number; residents: number; blocks: number; weeklyTrips: number
  segments: number; gaps: number; footP50: number; footP75?: number; bbox: [number, number, number, number]; center: LngLat
}

export type IndexData = {
  built: string
  vision: string
  visionSource?: string
  visionMinConfidence?: number
  params: { cutoffM: number; decayM: number; stepsFactor: number; shelterFactor: number; unsignalisedCrossingM: number; benchGapM: number }
  destTypes: Record<string, { label: string; perWeek: number }>
  barriers: Record<string, BarrierDef>
  unknown: Record<string, string>
  totals: { seniors: number; blocks: number; weeklyTrips: number; segments: number; gaps: number }
  towns: TownSummary[]
}

export type Seg = {
  id: string; way: number; name: string | null; hw: string; len: number; foot: number
  barriers: string[]; unknown: string[]; covered: boolean; vision?: boolean
}

export type Gap = {
  id: string; barrier: string; label: string; severity: number; fix: string; effort: Effort
  foot: number; len: number; name: string | null; near?: string | null; segs: string[]; at: LngLat; source: string; town: string
  sv?: { pano: string; date?: string; heading?: number } | null
  corrected?: boolean
}

type Check = { value: 'yes' | 'no' | 'unknown'; confidence: number }
export type VisionEntry = {
  status: 'ok' | 'no_imagery' | 'refused' | 'error'; pano?: string; date?: string; heading?: number; model?: string
  checklist?: { shelter?: Check; bench?: Check; steps?: Check; ramp?: Check; surface_ok?: Check; obstruction?: Check; signage?: Check; notes?: string }
}

export type Verdict = 'correct' | 'wrong' | 'missed'
export type Feedback = {
  id?: number | string; town: string; segment: string; gap: string | null; barrier: string | null
  verdict: Verdict; note: string | null; created: string
}

export type Route = { id?: number | string; town: string; destination_type: string | null; coords: LngLat[]; created: string }

export type SegInfo = Seg & { mid: LngLat; coords: LngLat[] }

export type Corrected = {
  /** effective barriers per segment id, after corrections */
  barriers: Map<string, string[]>
  /** (segment|barrier) pairs that residents touched, with their latest verdict */
  verdicts: Map<string, Verdict>
  gaps: Gap[]
}

/** Latest verdict per (segment, barrier) wins. A row with `gap` applies to every segment of that gap. */
export function applyCorrections(segs: Map<string, SegInfo>, baseGaps: Gap[], feedback: Feedback[], defs: Record<string, BarrierDef>): Corrected {
  const gapById = new Map(baseGaps.map(g => [g.id, g]))
  const verdicts = new Map<string, Verdict>()
  const sorted = [...feedback].sort((a, b) => a.created.localeCompare(b.created))
  for (const f of sorted) {
    const g = f.gap ? gapById.get(f.gap) : undefined
    const barrier = f.barrier ?? (f.gap ? f.gap.slice(f.gap.indexOf(':') + 1) : null)
    if (!barrier || !defs[barrier]) continue
    for (const s of g ? g.segs : [f.segment]) if (segs.has(s)) verdicts.set(`${s}|${barrier}`, f.verdict)
  }

  const barriers = new Map<string, string[]>()
  for (const [id, s] of segs) barriers.set(id, s.barriers)
  for (const [key, v] of verdicts) {
    const [sid, b] = key.split('|')
    const cur = barriers.get(sid)!
    const has = cur.includes(b)
    if (v === 'wrong' && has) barriers.set(sid, cur.filter(x => x !== b))
    if (v !== 'wrong' && !has) barriers.set(sid, [...cur, b])
  }

  // Rebuild gaps exactly like the pipeline (gap = one way + one barrier; foot = busiest segment; len = sum),
  // but only for the gaps residents touched, so untouched gaps keep their published numbers.
  const out: Gap[] = []
  for (const g of baseGaps) {
    const touched = g.segs.some(s => verdicts.has(`${s}|${g.barrier}`))
    if (!touched) { out.push(g); continue }
    const left = g.segs.filter(s => barriers.get(s)?.includes(g.barrier))
    if (!left.length) continue
    out.push({ ...rebuild(g, left.map(s => segs.get(s)!)), corrected: true })
  }
  // Barriers residents added (missed, or confirmed on a segment the pipeline skipped) that no gap covers yet.
  const added = new Map<string, SegInfo[]>()
  for (const [key, v] of verdicts) {
    if (v === 'wrong') continue
    const [sid, b] = key.split('|')
    const s = segs.get(sid)!
    const gid = `${s.way}:${b}`
    const existing = out.find(g => g.id === gid)
    if (existing?.segs.includes(sid)) continue
    if (!added.has(gid)) added.set(gid, [])
    added.get(gid)!.push(s)
  }
  for (const [gid, extra] of added) {
    const i = out.findIndex(g => g.id === gid)
    const b = gid.slice(gid.indexOf(':') + 1)
    const d = defs[b]
    const base: Gap = i >= 0 ? out[i] : {
      id: gid, barrier: b, label: d.label, severity: d.severity, fix: d.fix, effort: d.effort,
      foot: 0, len: 0, name: null, near: null, segs: [], at: extra[0].mid, source: 'Reported by residents', town: baseGaps[0]?.town ?? '',
    }
    const all = [...base.segs.map(s => segs.get(s)!).filter(Boolean), ...extra]
    const g = { ...rebuild(base, all), corrected: true }
    if (i >= 0) out[i] = g; else out.push(g)
  }
  return { barriers, verdicts, gaps: out }
}

function rebuild(g: Gap, list: SegInfo[]): Gap {
  let top = list[0]
  for (const s of list) if (s.foot >= top.foot) top = s
  return {
    ...g, segs: list.map(s => s.id), foot: top.foot, at: top.mid,
    len: list.reduce((a, s) => a + s.len, 0), name: g.name ?? list.find(s => s.name)?.name ?? null,
  }
}

export type SortMode = 'impact' | 'seniors' | 'quick'
const EFFORT_RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2 }

export function sortGaps(gaps: Gap[], mode: SortMode): Gap[] {
  const impact = (g: Gap) => g.foot * g.severity
  return [...gaps].sort((a, b) =>
    mode === 'seniors' ? b.foot - a.foot || impact(b) - impact(a)
      : mode === 'quick' ? EFFORT_RANK[a.effort] - EFFORT_RANK[b.effort] || impact(b) - impact(a)
        : impact(b) - impact(a))
}

/**
 * Share of resident-route length within `tolM` metres of a busy modelled segment (foot >= p50).
 * Planar equirectangular maths, fine at town scale.
 * ponytail: O(route samples x nearby edges) via a 50 m grid; enough for a few hundred routes per town.
 */
export function routeAccuracy(routes: Route[], segs: Iterable<SegInfo>, p50: number, tolM = 30): { share: number; lengthM: number } | null {
  const pts = routes.flatMap(r => r.coords)
  if (!pts.length) return null
  const lat0 = pts[0][1] * Math.PI / 180
  const kx = 111320 * Math.cos(lat0), ky = 110540
  const P = ([lng, lat]: LngLat): [number, number] => [lng * kx, lat * ky]
  const CELL = 50
  const grid = new Map<string, [number, number, number, number][]>()
  for (const s of segs) {
    if (s.foot < p50) continue
    for (let i = 1; i < s.coords.length; i++) {
      const [ax, ay] = P(s.coords[i - 1]), [bx, by] = P(s.coords[i])
      for (let cx = Math.floor((Math.min(ax, bx) - tolM) / CELL); cx <= Math.floor((Math.max(ax, bx) + tolM) / CELL); cx++)
        for (let cy = Math.floor((Math.min(ay, by) - tolM) / CELL); cy <= Math.floor((Math.max(ay, by) + tolM) / CELL); cy++) {
          const k = `${cx},${cy}`
          if (!grid.has(k)) grid.set(k, [])
          grid.get(k)!.push([ax, ay, bx, by])
        }
    }
  }
  const near = (x: number, y: number) => (grid.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`) ?? [])
    .some(([ax, ay, bx, by]) => distToSeg(x, y, ax, ay, bx, by) <= tolM)
  let total = 0, inside = 0
  for (const r of routes) for (let i = 1; i < r.coords.length; i++) {
    const [ax, ay] = P(r.coords[i - 1]), [bx, by] = P(r.coords[i])
    const len = Math.hypot(bx - ax, by - ay)
    const n = Math.max(1, Math.ceil(len / 5))
    for (let j = 0; j < n; j++) {
      const t = (j + 0.5) / n
      total += len / n
      if (near(ax + (bx - ax) * t, ay + (by - ay) * t)) inside += len / n
    }
  }
  return total > 0 ? { share: inside / total, lengthM: total } : null
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay
  const L = dx * dx + dy * dy
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

/** Quantile class breaks for a stepped scale, rounded to readable numbers and kept strictly increasing. */
export function breaks(values: number[], qs: number[]): number[] {
  if (!values.length) return []
  const v = [...values].sort((a, b) => a - b)
  const out: number[] = []
  for (const q of qs) {
    const raw = v[Math.min(v.length - 1, Math.floor(q * v.length))]
    const mag = 10 ** Math.max(0, Math.floor(Math.log10(Math.max(raw, 1))) - 1)
    const b = Math.max(Math.round(raw / mag) * mag, (out.at(-1) ?? 0) + 1)
    out.push(b)
  }
  return out
}
