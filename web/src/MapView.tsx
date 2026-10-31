import { useEffect, useRef, useState } from 'react'
import { Map as MLMap, setWorkerUrl, AttributionControl, NavigationControl, Popup, Marker, type GeoJSONSource, type MapMouseEvent, type ExpressionSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre 6 finds its worker next to its own module file, which a bundle breaks. Hand it a bundled worker instead.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
setWorkerUrl(workerUrl)
import type { FeatureCollection, Geometry } from 'geojson'
import type { Gap, LngLat, Route } from './logic.ts'

export type Layers = { footfall: boolean; barriers: boolean; blocks: boolean; destinations: boolean; routes: boolean }
export type Scheme = 'light' | 'dark'
export type FlyTarget = { bbox?: [number, number, number, number]; center?: LngLat; zoom?: number; n: number }

// Map paint cannot read CSS variables, so the data colours live here, one set per scheme.
// Sequential ramp: one blue hue, light to dark on the light basemap, flipped on the dark one (dataviz reference ramp).
export const MAP_COLORS = {
  light: {
    ramp: ['#9ec5f4', '#6da7ec', '#2a78d6', '#1c5cab', '#0d366b'],
    barrier: '#c93636', ring: '#fafafa', highlight: '#0f766e', route: '#d4541f',
    block: '#71717a', dest: '#27272a', outline: '#52525b', muted: '#71717a', bg: '#f4f4f5', veil: '#52525b',
  },
  dark: {
    ramp: ['#1c5cab', '#2a78d6', '#5598e7', '#86b6ef', '#cde2fb'],
    barrier: '#ec7070', ring: '#0b0b0d', highlight: '#2dd4bf', route: '#f08a5d',
    block: '#a1a1aa', dest: '#e4e4e7', outline: '#a1a1aa', muted: '#a1a1aa', bg: '#18181b', veil: '#09090b',
  },
}

const COARSE = matchMedia('(pointer: coarse)').matches
const SG_BOUNDS: [number, number, number, number] = [103.6, 1.2, 104.05, 1.475]
const OM = 'https://www.onemap.gov.sg/maps/tiles'
const ATTRIBUTION =
  '<img src="https://www.onemap.gov.sg/web-assets/images/logo/om_logo.png" alt="" style="height:20px;width:20px;vertical-align:middle"/> ' +
  '<a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener noreferrer">OneMap</a> &copy; contributors | ' +
  '<a href="https://www.sla.gov.sg/" target="_blank" rel="noopener noreferrer">Singapore Land Authority</a>'
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }

type Props = {
  scheme: Scheme
  reducedMotion: boolean
  padding: { top: number; right: number; bottom: number; left: number }
  subzones: FeatureCollection | null
  subzoneBreaks: number[]
  town: string | null
  segments: FeatureCollection | null
  footBreaks: number[]
  gaps: Gap[]
  pin: { at: LngLat; label: string } | null
  /** town footfall medians: below p50 fades, p75+ is a hotspot */
  footP: [number, number] | null
  /** segment ids of the top hotspot stretches, drawn thickest */
  hotIds: string[]
  /** numbered markers for the top fixes */
  numbered: { id: string; at: LngLat; label: string }[]
  blocks: FeatureCollection | null
  destinations: FeatureCollection | null
  destLabels: Record<string, string>
  routes: Route[]
  draft: LngLat[] | null
  highlight: string[]
  layers: Layers
  fly: FlyTarget | null
  onTown: (slug: string) => void
  onSegment: (id: string) => void
  onGap: (id: string) => void
  onPoint: (p: LngLat) => void
  onEmpty: () => void
  onRightDrag: () => void
  onMapReady: (map: MLMap) => void
}

// Selected line: 6px at town zoom, 10px close up, with a 3.5px casing each side.
const HL_WIDTH = ['interpolate', ['linear'], ['zoom'], 13, 6, 16, 9, 18, 11] as unknown as ExpressionSpecification
const HL_CASE = ['interpolate', ['linear'], ['zoom'], 13, 13, 16, 16, 18, 18] as unknown as ExpressionSpecification
const HL_PULSE = ['interpolate', ['linear'], ['zoom'], 13, 12, 16, 16, 18, 18] as unknown as ExpressionSpecification

const step = (prop: string, br: number[], vals: (string | number)[]): ExpressionSpecification =>
  br.length ? ['step', ['get', prop], vals[0], ...br.flatMap((b, i) => [b, vals[i + 1]])] as unknown as ExpressionSpecification : vals[0] as unknown as ExpressionSpecification

export default function MapView(p: Props) {
  const el = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MLMap | null>(null)
  const live = useRef(p)
  live.current = p
  const [ready, setReady] = useState(false)
  const pinMarker = useRef<Marker | null>(null)
  const numMarkers = useRef<Marker[]>([])

  useEffect(() => {
    const map = new MLMap({
      container: el.current!,
      bounds: SG_BOUNDS,
      maxBounds: [103.45, 1.1, 104.2, 1.55],
      minZoom: 11, maxZoom: 19, maxPitch: 0,
      attributionControl: false,
      // North-up only. Mouse pans with right-drag (below); touch keeps one-finger pan.
      dragRotate: false, pitchWithRotate: false, touchPitch: false,
      dragPan: COARSE,
      style: {
        version: 8,
        sources: {
          light: { type: 'raster', tiles: [`${OM}/Grey/{z}/{x}/{y}.png`], tileSize: 256, minzoom: 11, maxzoom: 19, bounds: [103.5, 1.1, 104.2, 1.55], attribution: ATTRIBUTION },
          dark: { type: 'raster', tiles: [`${OM}/Night/{z}/{x}/{y}.png`], tileSize: 256, minzoom: 11, maxzoom: 19, bounds: [103.5, 1.1, 104.2, 1.55], attribution: ATTRIBUTION },
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#f4f4f5' } },
          { id: 'base-light', type: 'raster', source: 'light' },
          { id: 'base-dark', type: 'raster', source: 'dark', layout: { visibility: 'none' } },
        ],
      },
    })
    map.addControl(new AttributionControl({ compact: true, customAttribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors' }), 'bottom-right')
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right')
    map.getCanvas().setAttribute('aria-label', 'Map of Singapore footpaths. Use arrow keys to pan and plus or minus to zoom.')
    mapRef.current = map
    map.touchZoomRotate.disableRotation()
    map.keyboard.disableRotation()

    // Right-button drag pans; left click only selects.
    const box = map.getContainer()
    let last: [number, number] | null = null
    const onMove = (e: MouseEvent) => {
      if (!last) return
      map.panBy([last[0] - e.clientX, last[1] - e.clientY], { animate: false })
      last = [e.clientX, e.clientY]
    }
    const stop = () => { last = null; box.classList.remove('panning'); removeEventListener('mousemove', onMove); removeEventListener('mouseup', stop) }
    const onDown = (e: MouseEvent) => {
      if (e.button !== 2) return
      last = [e.clientX, e.clientY]
      box.classList.add('panning')
      addEventListener('mousemove', onMove)
      addEventListener('mouseup', stop)
      live.current.onRightDrag()
    }
    const noMenu = (e: Event) => e.preventDefault()
    box.addEventListener('mousedown', onDown)
    box.addEventListener('contextmenu', noMenu)
    document.documentElement.addEventListener('mouseleave', stop)

    map.on('load', () => {
      for (const id of ['subzones', 'segments', 'gaps', 'blocks', 'dests', 'routes', 'draft'])
        map.addSource(id, { type: 'geojson', data: EMPTY })
      map.addLayer({ id: 'subzones-fill', type: 'fill', source: 'subzones', paint: { 'fill-opacity': 0.5 } })
      map.addLayer({ id: 'subzones-line', type: 'line', source: 'subzones', paint: { 'line-width': 0.6, 'line-opacity': 0.5 } })
      map.addLayer({ id: 'blocks', type: 'circle', source: 'blocks', paint: {
        'circle-radius': ['interpolate', ['linear'], ['sqrt', ['get', 'seniors']], 0, 2, 15, 9],
        'circle-opacity': 0.55,
      } })
      map.addLayer({ id: 'segments', type: 'line', source: 'segments', layout: { 'line-cap': 'round', 'line-join': 'round' } })
      map.addLayer({ id: 'segments-hit', type: 'line', source: 'segments', paint: { 'line-width': 16, 'line-opacity': 0 } })
      map.addLayer({ id: 'routes', type: 'line', source: 'routes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-width': 3, 'line-dasharray': [2, 1.5] } })
      map.addLayer({ id: 'dests', type: 'circle', source: 'dests', paint: { 'circle-radius': 5, 'circle-stroke-width': 2, 'circle-opacity': 0 } })
      map.addLayer({ id: 'gaps', type: 'circle', source: 'gaps', paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, ['+', 1.5, ['*', 0.8, ['get', 'severity']]], 16, ['+', 3, ['*', 1.6, ['get', 'severity']]]],
        'circle-stroke-width': 2,
      } })
      map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', paint: { 'line-width': 4 } })
      map.addLayer({ id: 'draft-pts', type: 'circle', source: 'draft', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 6, 'circle-stroke-width': 2 } })
      // The selection sits above every other layer.
      map.addLayer({ id: 'highlight-case', type: 'line', source: 'segments', filter: ['in', ['get', 'id'], ['literal', []]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-width': HL_CASE } })
      map.addLayer({ id: 'highlight', type: 'line', source: 'segments', filter: ['in', ['get', 'id'], ['literal', []]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-width': HL_WIDTH } })
      map.fitBounds(live.current.fly?.bbox ?? SG_BOUNDS, { padding: live.current.padding, duration: 0, maxZoom: 17.5 })
      map.setBearing(0); map.setPitch(0)
      setReady(true)
      live.current.onMapReady(map)
    })

    const pick = (e: MapMouseEvent) => {
      const b: [[number, number], [number, number]] = [[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]]
      const layers = ['gaps', 'segments-hit', ...(live.current.town ? [] : ['subzones-fill'])].filter(l => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none')
      return map.queryRenderedFeatures(b, { layers })[0]
    }
    map.on('click', e => {
      const c = live.current
      if (c.draft) return c.onPoint([+e.lngLat.lng.toFixed(6), +e.lngLat.lat.toFixed(6)])
      const f = pick(e)
      if (!f) return c.onEmpty()
      if (f.layer.id === 'gaps') c.onGap(String(f.properties.id))
      else if (f.layer.id === 'segments-hit') c.onSegment(String(f.properties.id))
      else if (f.layer.id === 'subzones-fill' && f.properties.town) c.onTown(String(f.properties.town))
    })
    map.on('mousemove', e => {
      map.getCanvas().style.cursor = live.current.draft ? 'crosshair' : pick(e) ? 'pointer' : ''
    })
    const pinEl = document.createElement('div')
    pinEl.className = 'pin'
    pinEl.setAttribute('role', 'img')
    pinMarker.current = new Marker({ element: pinEl })
    const tip = new Popup({ closeButton: false, closeOnClick: false, offset: 10 })
    map.on('mouseenter', 'dests', e => {
      const f = e.features?.[0]
      if (!f) return
      const label = live.current.destLabels[f.properties.type] ?? f.properties.type
      const node = document.createElement('div')
      node.className = 'tip'
      node.textContent = f.properties.name ? `${f.properties.name} (${label})` : label
      tip.setLngLat((f.geometry as GeoJSON.Point).coordinates as LngLat).setDOMContent(node).addTo(map)
    })
    map.on('mouseleave', 'dests', () => tip.remove())
    return () => { stop(); document.documentElement.removeEventListener('mouseleave', stop); map.remove() }
  }, [])

  const map = ready ? mapRef.current : null
  const set = (id: string, data: FeatureCollection | null) => (map?.getSource(id) as GeoJSONSource | undefined)?.setData(data ?? EMPTY)

  const focus = p.highlight.length > 0

  // Colours follow the scheme; a selection greys out everything else.
  useEffect(() => {
    if (!map) return
    const c = MAP_COLORS[p.scheme]
    map.setPaintProperty('bg', 'background-color', c.bg)
    for (const id of ['base-light', 'base-dark']) {
      map.setPaintProperty(id, 'raster-saturation', focus ? -1 : 0)
      map.setPaintProperty(id, 'raster-brightness-max', focus ? (p.scheme === 'light' ? 0.72 : 0.6) : 1)
      map.setPaintProperty(id, 'raster-opacity', focus && p.scheme === 'light' ? 0.75 : 1)
    }
    map.setLayoutProperty('base-light', 'visibility', p.scheme === 'light' ? 'visible' : 'none')
    map.setLayoutProperty('base-dark', 'visibility', p.scheme === 'dark' ? 'visible' : 'none')
    // National: subzones shaded by seniors. Town: a grey veil over every other town.
    map.setPaintProperty('subzones-fill', 'fill-color', p.town ? c.veil : step('seniors', p.subzoneBreaks, c.ramp))
    map.setPaintProperty('subzones-fill', 'fill-opacity', p.town ? ['case', ['==', ['get', 'town'], p.town], 0, 0.35] : 0.5)
    map.setPaintProperty('subzones-line', 'line-color', c.outline)
    map.setPaintProperty('subzones-line', 'line-opacity', p.town ? 0 : 0.5)
    // Hotspots by default: quiet paths (below the town median) thin and pale, busiest quarter bold,
    // the top stretches boldest. A selection turns every other line grey.
    const [p50, p75] = p.footP ?? [0, 0]
    const hot = ['in', ['get', 'id'], ['literal', p.hotIds]]
    const w = (lo: number, mid: number, high: number, top: number) =>
      ['case', hot, top, ['<', ['get', 'foot'], p50], lo, ['<', ['get', 'foot'], p75], mid, high]
    map.setPaintProperty('segments', 'line-color', focus ? c.muted : ['case', hot, c.ramp[4], step('foot', p.footBreaks, c.ramp)] as unknown as ExpressionSpecification)
    map.setPaintProperty('segments', 'line-opacity', focus ? 0.25 : ['case', ['<', ['get', 'foot'], p50], 0.3, 1] as unknown as ExpressionSpecification)
    map.setPaintProperty('segments', 'line-width', focus ? 1.25 : ['interpolate', ['linear'], ['zoom'], 13, w(0.5, 1.2, 2.5, 5), 17, w(1, 2.5, 5, 11)] as unknown as ExpressionSpecification)
    map.setPaintProperty('gaps', 'circle-opacity', focus ? 0.35 : 1)
    map.setPaintProperty('highlight-case', 'line-color', c.ring)
    map.setPaintProperty('highlight', 'line-color', c.highlight)
    map.setPaintProperty('routes', 'line-color', focus ? c.muted : c.route)
    map.setPaintProperty('blocks', 'circle-color', focus ? c.muted : c.block)
    map.setPaintProperty('dests', 'circle-stroke-color', c.dest)
    map.setPaintProperty('gaps', 'circle-color', focus ? c.muted : c.barrier)
    map.setPaintProperty('gaps', 'circle-stroke-color', c.ring)
    map.setPaintProperty('draft-line', 'line-color', c.highlight)
    map.setPaintProperty('draft-pts', 'circle-color', c.highlight)
    map.setPaintProperty('draft-pts', 'circle-stroke-color', c.ring)
  }, [map, p.scheme, p.footBreaks, p.subzoneBreaks, p.town, focus, p.footP, p.hotIds])

  useEffect(() => { set('subzones', p.subzones) }, [map, p.subzones])
  useEffect(() => { set('segments', p.segments) }, [map, p.segments])
  useEffect(() => { set('blocks', p.blocks) }, [map, p.blocks])
  useEffect(() => { set('dests', p.destinations) }, [map, p.destinations])
  useEffect(() => {
    set('gaps', { type: 'FeatureCollection', features: p.gaps.map(g => ({ type: 'Feature', properties: { id: g.id, severity: g.severity }, geometry: { type: 'Point', coordinates: g.at } })) })
  }, [map, p.gaps])
  useEffect(() => {
    set('routes', { type: 'FeatureCollection', features: p.routes.filter(r => r.coords.length > 1).map(r => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: r.coords } })) })
  }, [map, p.routes])
  useEffect(() => {
    const d = p.draft ?? []
    const features: GeoJSON.Feature<Geometry>[] = d.map(c => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }))
    if (d.length > 1) features.unshift({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: d } })
    set('draft', { type: 'FeatureCollection', features })
  }, [map, p.draft])
  useEffect(() => {
    if (!map) return
    const f = ['in', ['get', 'id'], ['literal', p.highlight]] as ExpressionSpecification
    map.setFilter('highlight', f)
    map.setFilter('highlight-case', f)
    if (!p.highlight.length || p.reducedMotion) return
    // One brief pulse so the eye finds the new selection.
    map.setPaintProperty('highlight', 'line-width', HL_PULSE)
    const t = setTimeout(() => map.setPaintProperty('highlight', 'line-width', HL_WIDTH), 350)
    return () => clearTimeout(t)
  }, [map, p.highlight])

  // Numbered markers for the top fixes: real buttons, so they work from the keyboard too.
  useEffect(() => {
    if (!map) return
    numMarkers.current = p.numbered.map((g, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'gap-marker'
      b.textContent = String(i + 1)
      b.setAttribute('aria-label', `Fix ${i + 1}: ${g.label}`)
      b.addEventListener('click', e => { e.stopPropagation(); live.current.onGap(g.id) })
      return new Marker({ element: b }).setLngLat(g.at).addTo(map)
    })
    return () => { numMarkers.current.forEach(m => m.remove()); numMarkers.current = [] }
  }, [map, p.numbered])

  useEffect(() => {
    const m = pinMarker.current
    if (!map || !m) return
    if (!p.pin) { m.remove(); return }
    m.getElement().setAttribute('aria-label', `Selected: ${p.pin.label}`)
    m.setLngLat(p.pin.at).addTo(map)
  }, [map, p.pin?.at[0], p.pin?.at[1], p.pin?.label])
  useEffect(() => {
    if (!map) return
    const vis = (id: string, on: boolean) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
    vis('subzones-fill', true)
    vis('subzones-line', true)
    vis('segments', p.layers.footfall)
    vis('segments-hit', p.layers.footfall)
    vis('gaps', p.layers.barriers)
    vis('blocks', p.layers.blocks)
    vis('dests', p.layers.destinations)
    vis('routes', p.layers.routes)
  }, [map, p.layers])

  useEffect(() => {
    if (!map || !p.fly) return
    const opts = { padding: p.padding, duration: p.reducedMotion ? 0 : 1000, maxZoom: 17.5 }
    if (p.fly.bbox) map.fitBounds(p.fly.bbox, opts)
    else if (p.fly.center) {
      const cam = { center: p.fly.center, zoom: Math.max(map.getZoom(), p.fly.zoom ?? 16.5), padding: p.padding }
      if (p.reducedMotion) map.jumpTo(cam); else map.flyTo({ ...cam, duration: 1000 })
    }
  }, [map, p.fly])

  return <div ref={el} className="map" />
}
