// Run: node src/logic.check.ts  (Node 22.18+ strips types natively)
import { applyCorrections, sortGaps, routeAccuracy, type SegInfo, type Gap, type Feedback } from './logic.ts'
import assert from 'node:assert/strict'

const defs = {
  steps: { label: 'Steps', severity: 3, fix: 'Ramp', effort: 'high' as const },
  kerb: { label: 'Kerb', severity: 2, fix: 'Kerb ramp', effort: 'low' as const },
}
const seg = (id: string, way: number, foot: number, barriers: string[], x: number): SegInfo => ({
  id, way, name: null, hw: 'footway', len: 100, foot, barriers, unknown: [], covered: false,
  coords: [[103.8 + x, 1.37], [103.801 + x, 1.37]], mid: [103.8005 + x, 1.37],
})
const segs = new Map([seg('a', 1, 500, ['steps'], 0), seg('b', 1, 300, ['steps'], 0.001), seg('c', 2, 1000, [], 0.002)].map(s => [s.id, s]))
const gaps: Gap[] = [{ id: '1:steps', barrier: 'steps', label: 'Steps', severity: 3, fix: 'Ramp', effort: 'high', foot: 500, len: 200, name: null, segs: ['a', 'b'], at: [0, 0], source: 'OSM', town: 't' }]
const fb = (segment: string, barrier: string | null, verdict: Feedback['verdict'], created: string, gap: string | null = null): Feedback =>
  ({ town: 't', segment, gap, barrier, verdict, note: null, created })

// untouched
assert.equal(applyCorrections(segs, gaps, [], defs).gaps[0], gaps[0])
// wrong on the busiest seg: gap shrinks to b, foot drops to 300
let r = applyCorrections(segs, gaps, [fb('a', 'steps', 'wrong', '1')], defs)
assert.deepEqual([r.gaps[0].segs, r.gaps[0].foot, r.gaps[0].len, r.gaps[0].corrected], [['b'], 300, 100, true])
// wrong on whole gap removes it; later correct restores it (latest wins)
assert.equal(applyCorrections(segs, gaps, [fb('a', null, 'wrong', '1', '1:steps')], defs).gaps.length, 0)
assert.equal(applyCorrections(segs, gaps, [fb('a', null, 'wrong', '1', '1:steps'), fb('a', null, 'correct', '2', '1:steps')], defs).gaps[0].foot, 500)
// missed kerb on c creates gap 2:kerb that outranks steps (1000*2 > 500*3)
r = applyCorrections(segs, gaps, [fb('c', 'kerb', 'missed', '1')], defs)
assert.deepEqual(sortGaps(r.gaps, 'impact').map(g => g.id), ['2:kerb', '1:steps'])
assert.deepEqual(sortGaps(r.gaps, 'quick').map(g => g.id), ['2:kerb', '1:steps'])
assert.deepEqual(r.barriers.get('c'), ['kerb'])
// route along seg c (foot 1000 >= p50 500) is 100% on busy paths; far away route is 0%
assert.equal(routeAccuracy([{ town: 't', destination_type: null, coords: [[103.8021, 1.3701], [103.8029, 1.3701]], created: '' }], segs.values(), 500)!.share, 1)
assert.equal(routeAccuracy([{ town: 't', destination_type: null, coords: [[103.9, 1.4], [103.901, 1.4]], created: '' }], segs.values(), 500)!.share, 0)
// planned works count half: 1:steps (500x3=1500) planned -> 750, below 2:kerb (1000x2=2000) either way; 400x3 unplanned beats it
assert.deepEqual(sortGaps([{ ...gaps[0], planned: { note: 'n', source: 's' } }, { ...gaps[0], id: 'x', foot: 300 }], 'impact').map(g => g.id), ['x', '1:steps'])
console.log('logic ok')
// hotspots: a (1-2) and b (2-3) share node 2 on way 1 and merge; c (way 2) stays separate; below p75 is dropped
{
  const hs = (await import('./logic.ts')).hotspots
  const S = (id: string, way: number, foot: number): SegInfo => ({ ...seg(id, way, foot, [], 0), id })
  const h = hs([S('1-2-0', 1, 500), S('2-3-0', 1, 400), S('7-8-0', 2, 900), S('8-9-0', 3, 10)], 300)
  assert.deepEqual(h.map(x => [x.segs.length, x.foot]), [[1, 900], [2, 500]])
  console.log('hotspots ok')
}
// risk areas: two gaps 100 m apart merge, a third 1 km away stays alone; bigger score first
{
  const { riskAreas } = await import('./logic.ts')
  const G = (id: string, x: number, foot: number): Gap => ({ ...gaps[0], id, at: [103.8 + x, 1.37], foot, segs: [] })
  const r = riskAreas([G('a', 0, 100), G('b', 0.0009, 100), G('c', 0.01, 150)])
  assert.deepEqual(r.map(a => [a.gaps.length, a.score]), [[2, 600], [1, 450]])
  assert.ok(r[0].radiusM >= 80)
  console.log('risk ok')
}
// visible midpoint: a line from x=0..10 clipped to x 2..6 puts the icon at x=4; off-screen gives null
{
  const { visibleMidpoint } = await import('./logic.ts')
  const m = visibleMidpoint([[[103.80, 1.37], [103.81, 1.37]]], [103.802, 1.36, 103.806, 1.38])!
  assert.ok(Math.abs(m[0] - 103.804) < 1e-9 && m[1] === 1.37)
  assert.equal(visibleMidpoint([[[103.80, 1.37], [103.81, 1.37]]], [104, 1.36, 104.1, 1.38]), null)
  console.log('midpoint ok')
}
