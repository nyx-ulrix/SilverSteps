// Pure data logic: types, corrections, ranking, route accuracy. No imports so it runs under plain `node`.

export type LngLat = [number, number]
export type Effort = 'low' | 'medium' | 'high'
export type Profile = 'mobility' | 'sight'
export type BarrierDef = { label: string; severity: number; fix: string; effort: Effort; profiles?: Profile[] }

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
  profiles?: Record<Profile, string>
  totals: { seniors: number; blocks: number; weeklyTrips: number; segments: number; gaps: number }
  towns: TownSummary[]
}

export type Seg = {
  id: string; way: number | string; name: string | null; hw: string; len: number; foot: number
  barriers: string[]; unknown: string[]; covered: boolean; vision?: boolean
  xing?: 'signals' | 'zebra' | 'uncontrolled' | null
}

export type Gap = {
  id: string; barrier: string; label: string; severity: number; fix: string; effort: Effort
  foot: number; len: number; name: string | null; near?: string | null; segs: string[]; at: LngLat; source: string; town: string
  sv?: { pano: string; date?: string; heading?: number } | null
  owner?: string
  planned?: { note: string; source: string } | null
  corrected?: boolean
}

type Check = { value: 'yes' | 'no' | 'unknown'; confidence: number }
export type VisionEntry = {
  status: 'ok' | 'no_imagery' | 'refused' | 'error'; pano?: string; date?: string; heading?: number; model?: string
  checklist?: { tactile_paving?: Check; ped_signal?: Check; shelter?: Check; bench?: Check; steps?: Check; ramp?: Check; surface_ok?: Check; obstruction?: Check; signage?: Check; notes?: string }
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

/** Works already planned (HDB / LTA) count half in every sort mode, so unplanned barriers rise. */
const plannedFactor = (g: Gap) => (g.planned ? 0.5 : 1)

export function sortGaps(gaps: Gap[], mode: SortMode): Gap[] {
  const impact = (g: Gap) => g.foot * g.severity * plannedFactor(g)
  const foot = (g: Gap) => g.foot * plannedFactor(g)
  return [...gaps].sort((a, b) =>
    mode === 'seniors' ? foot(b) - foot(a) || impact(b) - impact(a)
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

export type Hotspot = { id: string; segs: string[]; foot: number; len: number; name: string | null; at: LngLat }

/**
 * Busiest stretches: segments with foot >= p75, joined when they touch (share an OSM node, from the
 * "u-v-k" id) and carry the same street name (or the same way when unnamed). Ranked by their busiest segment.
 */
export function hotspots(segs: Iterable<SegInfo>, p75: number, n = 10): Hotspot[] {
  const busy = [...segs].filter(s => s.foot >= p75)
  const parent = new Map<string, string>(busy.map(s => [s.id, s.id]))
  const find = (x: string): string => { while (parent.get(x) !== x) { const p = parent.get(parent.get(x)!)!; parent.set(x, p); x = p } return x }
  const byNode = new Map<string, string>()
  for (const s of busy) {
    const key = s.name ?? `w${s.way}`
    for (const node of s.id.split('-').slice(0, 2)) {
      const k = `${key}|${node}`
      const other = byNode.get(k)
      if (other) parent.set(find(s.id), find(other)); else byNode.set(k, s.id)
    }
  }
  const groups = new Map<string, SegInfo[]>()
  for (const s of busy) { const r = find(s.id); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(s) }
  return [...groups.values()].map(list => {
    let top = list[0]
    for (const s of list) if (s.foot > top.foot) top = s
    return { id: `hot:${top.id}`, segs: list.map(s => s.id), foot: top.foot, len: list.reduce((a, s) => a + s.len, 0), name: top.name, at: top.mid }
  }).sort((a, b) => b.foot - a.foot).slice(0, n)
}

// Until the pipeline tags every barrier with `profiles`, assume these.
const SIGHT_ONLY = new Set(['no_tactile', 'silent_signal'])
const BOTH = new Set(['crossing', 'obstruction', 'surface', 'dark'])
export function affects(defs: Record<string, BarrierDef>, barrier: string, who: Profile | 'all'): boolean {
  if (who === 'all') return true
  const ps = defs[barrier]?.profiles ?? (SIGHT_ONLY.has(barrier) ? ['sight'] : BOTH.has(barrier) ? ['mobility', 'sight'] : ['mobility'])
  return ps.includes(who)
}

/** Metres between two points, planar (fine at town scale). */
export const metresBetween = (a: LngLat, b: LngLat) =>
  Math.hypot((a[0] - b[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * 110540)

export type RiskArea = { id: string; gaps: Gap[]; score: number; center: LngLat; radiusM: number }

/**
 * Highest-risk areas: greedily, the worst remaining gap takes every gap within `linkM` of it. Scored by sum of foot x severity.
 * ponytail: O(n^2) scan; fine for a few hundred gaps per town.
 */
export function riskAreas(gaps: Gap[], n = 5, linkM = 150): RiskArea[] {
  const left = [...gaps].sort((a, b) => b.foot * b.severity - a.foot * a.severity)
  const out: RiskArea[] = []
  while (left.length) {
    // Seeded on the worst remaining gap, so each area stays compact (no chaining across a town).
    const members = [left.shift()!]
    for (let i = left.length - 1; i >= 0; i--)
      if (metresBetween(members[0].at, left[i].at) <= linkM) members.push(...left.splice(i, 1))
    const center: LngLat = [members.reduce((a, g) => a + g.at[0], 0) / members.length, members.reduce((a, g) => a + g.at[1], 0) / members.length]
    out.push({
      id: `risk:${members[0].id}`, gaps: members, center,
      score: members.reduce((a, g) => a + g.foot * g.severity, 0),
      radiusM: Math.max(80, Math.max(...members.map(g => metresBetween(center, g.at))) + 40),
    })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, n)
}

/** A circle polygon for MapLibre, `steps` points around. */
export function circle([lng, lat]: LngLat, radiusM: number, steps = 48): LngLat[] {
  const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = (i / steps) * 2 * Math.PI
    return [lng + (radiusM * Math.cos(t)) / kx, lat + (radiusM * Math.sin(t)) / ky] as LngLat
  })
}

export type BlockRoute = {
  id: number | string; blk: string; type: string; dest: string; len: number; trips: number; share: number
  barriers: string[]; coords: LngLat[]
}

/** Distance from a point to a polyline, metres. */
export function distToLine(p: LngLat, line: LngLat[]): number {
  const kx = 111320 * Math.cos(p[1] * Math.PI / 180), ky = 110540
  let best = Infinity
  for (let i = 1; i < line.length; i++) {
    const ax = (line[i - 1][0] - p[0]) * kx, ay = (line[i - 1][1] - p[1]) * ky
    const bx = (line[i][0] - p[0]) * kx, by = (line[i][1] - p[1]) * ky
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy
    const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy))
  }
  return best
}

/**
 * One icon per long gap: the point halfway (by length) along the parts of its lines inside `bbox`
 * [w, s, e, n]. Planar Liang-Barsky clipping per segment. Null when nothing is visible.
 */
export function visibleMidpoint(lines: LngLat[][], [w, s, e, n]: [number, number, number, number]): LngLat | null {
  const parts: [LngLat, LngLat, number][] = []
  for (const line of lines) for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1], [x1, y1] = line[i]
    const dx = x1 - x0, dy = y1 - y0
    let t0 = 0, t1 = 1
    const clip = (p: number, q: number) => {
      if (p === 0) return q >= 0
      const r = q / p
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r } else { if (r < t0) return false; if (r < t1) t1 = r }
      return true
    }
    if (!(clip(-dx, x0 - w) && clip(dx, e - x0) && clip(-dy, y0 - s) && clip(dy, n - y0))) continue
    const a: LngLat = [x0 + t0 * dx, y0 + t0 * dy], b: LngLat = [x0 + t1 * dx, y0 + t1 * dy]
    const len = metresBetween(a, b)
    if (len > 0) parts.push([a, b, len])
  }
  let half = parts.reduce((t, p) => t + p[2], 0) / 2
  if (!half) return null
  for (const [a, b, len] of parts) {
    if (half <= len) { const t = half / len; return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] }
    half -= len
  }
  return parts.at(-1)![1]
}
