// Loaded only when a resident taps "Pick on a map", so the companion page stays light.
import { useEffect, useRef, useState } from 'react'
import { Map as MLMap, Marker, AttributionControl, NavigationControl, setWorkerUrl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
setWorkerUrl(workerUrl)

const OM = 'https://www.onemap.gov.sg/maps/tiles'
const ATTRIBUTION =
  '<img src="https://www.onemap.gov.sg/web-assets/images/logo/om_logo.png" alt="" style="height:20px;width:20px;vertical-align:middle"/> ' +
  '<a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener noreferrer">OneMap</a> &copy; contributors | ' +
  '<a href="https://www.sla.gov.sg/" target="_blank" rel="noopener noreferrer">Singapore Land Authority</a>'

export default function PickMap({ start, onPick, onCancel }: {
  start: [number, number] | null; onPick: (p: [number, number]) => void; onCancel: () => void
}) {
  const el = useRef<HTMLDivElement>(null)
  const [pin, setPin] = useState<[number, number] | null>(start)
  useEffect(() => {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches
    const map = new MLMap({
      container: el.current!, center: start ?? [103.82, 1.352], zoom: start ? 17 : 11.5, minZoom: 11, maxZoom: 19,
      maxBounds: [103.45, 1.1, 104.2, 1.55], dragRotate: false, pitchWithRotate: false, touchPitch: false, attributionControl: false,
      style: {
        version: 8,
        sources: { om: { type: 'raster', tiles: [`${OM}/${dark ? 'Night' : 'Grey'}/{z}/{x}/{y}.png`], tileSize: 256, minzoom: 11, maxzoom: 19, attribution: ATTRIBUTION } },
        layers: [{ id: 'om', type: 'raster', source: 'om' }],
      },
    })
    map.touchZoomRotate.disableRotation()
    map.addControl(new AttributionControl({ compact: true, customAttribution: '&copy; OpenStreetMap contributors' }), 'bottom-right')
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    map.getCanvas().setAttribute('aria-label', 'Map. Tap where the problem is to place a pin.')
    const el2 = document.createElement('div')
    el2.className = 'r-pin'
    const marker = new Marker({ element: el2, anchor: 'bottom' })
    if (start) marker.setLngLat(start).addTo(map)
    map.on('click', e => {
      const p: [number, number] = [+e.lngLat.lng.toFixed(6), +e.lngLat.lat.toFixed(6)]
      marker.setLngLat(p).addTo(map)
      setPin(p)
    })
    return () => map.remove()
  }, [])
  return (
    <div className="r-stack">
      <p className="r-muted">Tap the map where the problem is. Pinch to zoom in.</p>
      <div ref={el} className="r-map" />
      <button type="button" className="r-btn r-primary" disabled={!pin} onClick={() => pin && onPick(pin)}>
        {pin ? 'Use this spot' : 'Tap the map first'}
      </button>
      <button type="button" className="r-link r-center" onClick={onCancel}>Cancel</button>
    </div>
  )
}
