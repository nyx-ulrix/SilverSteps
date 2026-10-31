// Loaded only once a location is known (mini map) or a resident opens the map, so the page stays light.
import { useEffect, useRef, useState } from 'react'
import { Map as MLMap, Marker, AttributionControl, NavigationControl, setWorkerUrl, type GeoJSONSource, type StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
setWorkerUrl(workerUrl)

const OM = 'https://www.onemap.gov.sg/maps/tiles'
const ATTRIBUTION =
  '<img src="https://www.onemap.gov.sg/web-assets/images/logo/om_logo.png" alt="" style="height:20px;width:20px;vertical-align:middle"/> ' +
  '<a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener noreferrer">OneMap</a> &copy; contributors | ' +
  '<a href="https://www.sla.gov.sg/" target="_blank" rel="noopener noreferrer">Singapore Land Authority</a>'

const baseStyle = (): StyleSpecification => ({
  version: 8,
  sources: { om: { type: 'raster', tiles: [`${OM}/${matchMedia('(prefers-color-scheme: dark)').matches ? 'Night' : 'Grey'}/{z}/{x}/{y}.png`], tileSize: 256, minzoom: 11, maxzoom: 19, attribution: ATTRIBUTION } },
  layers: [{ id: 'om', type: 'raster', source: 'om' }],
})

/** Circle polygon, `r` metres around [lng, lat]. */
function ring([lng, lat]: [number, number], r: number): [number, number][] {
  const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540
  return Array.from({ length: 49 }, (_, i) => { const t = (i / 48) * 2 * Math.PI; return [lng + (r * Math.cos(t)) / kx, lat + (r * Math.sin(t)) / ky] })
}

/**
 * Small, non-interactive preview of the reported spot: a pin plus a translucent accuracy circle,
 * re-centred live as the GPS fix improves. Tapping it opens the full map to adjust.
 */
export function MiniMap({ lng, lat, accuracy, onOpen }: { lng: number; lat: number; accuracy: number; onOpen: () => void }) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<MLMap | null>(null)
  const marker = useRef<Marker | null>(null)
  useEffect(() => {
    const m = new MLMap({ container: el.current!, style: baseStyle(), center: [lng, lat], zoom: 16, interactive: false, attributionControl: false })
    m.addControl(new AttributionControl({ compact: true, customAttribution: '&copy; OpenStreetMap contributors' }), 'bottom-right')
    const pin = document.createElement('div')
    pin.className = 'r-pin'
    marker.current = new Marker({ element: pin, anchor: 'bottom' }).setLngLat([lng, lat]).addTo(m)
    m.on('load', () => {
      m.addSource('acc', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0f766e'
      m.addLayer({ id: 'acc', type: 'fill', source: 'acc', paint: { 'fill-color': accent, 'fill-opacity': 0.18 } })
      m.addLayer({ id: 'acc-line', type: 'line', source: 'acc', paint: { 'line-color': accent, 'line-width': 1.5 } })
      map.current = m
      update()
    })
    return () => { map.current = null; m.remove() }
  }, [])
  const update = () => {
    const m = map.current
    marker.current?.setLngLat([lng, lat])
    if (!m) return
    const r = Math.max(accuracy, 0)
    ;(m.getSource('acc') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: r > 0 ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring([lng, lat], r)] } }] : [] })
    // Frame the accuracy circle (or a ~60 m street view for exact points).
    const pts = ring([lng, lat], Math.max(r, 60))
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
    m.fitBounds([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], { padding: 12, maxZoom: 18, duration: 0 })
  }
  useEffect(update, [lng, lat, accuracy])
  return (
    <button type="button" className="r-mini-btn" onClick={onOpen} aria-label="Map of the reported spot. Tap to move the pin.">
      <div ref={el} className="r-mini" />
    </button>
  )
}

export default function PickMap({ start, onPick, onCancel }: {
  start: [number, number] | null; onPick: (p: [number, number]) => void; onCancel: () => void
}) {
  const el = useRef<HTMLDivElement>(null)
  const [pin, setPin] = useState<[number, number] | null>(start)
  useEffect(() => {
    const map = new MLMap({
      container: el.current!, center: start ?? [103.82, 1.352], zoom: start ? 17 : 11.5, minZoom: 11, maxZoom: 19,
      maxBounds: [103.45, 1.1, 104.2, 1.55], dragRotate: false, pitchWithRotate: false, touchPitch: false, attributionControl: false,
      style: baseStyle(),
    })
    map.touchZoomRotate.disableRotation()
    map.addControl(new AttributionControl({ compact: true, customAttribution: '&copy; OpenStreetMap contributors' }), 'bottom-right')
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    map.getCanvas().setAttribute('aria-label', 'Map. Tap where the problem is to place a pin.')
    const el2 = document.createElement('div')
    el2.className = 'r-pin'
    // Adjust mode: the pin can be dragged, or moved by tapping.
    const marker = new Marker({ element: el2, anchor: 'bottom', draggable: true })
    marker.on('dragend', () => { const ll = marker.getLngLat(); setPin([ll.lng, ll.lat]) })
    if (start) marker.setLngLat(start).addTo(map)
    map.on('click', e => {
      const p: [number, number] = [e.lngLat.lng, e.lngLat.lat]
      marker.setLngLat(p).addTo(map)
      setPin(p)
    })
    return () => map.remove()
  }, [])
  return (
    <div className="r-stack">
      <p className="r-muted">{start ? 'Drag the pin to the exact spot, or tap the map to move it.' : 'Tap the map where the problem is. Pinch to zoom in.'}</p>
      <div ref={el} className="r-map" />
      <button type="button" className="r-btn r-primary" disabled={!pin} onClick={() => pin && onPick(pin)}>
        {pin ? 'Use this spot' : 'Tap the map first'}
      </button>
      <button type="button" className="r-link r-center" onClick={onCancel}>Cancel</button>
    </div>
  )
}
