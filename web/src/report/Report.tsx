import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import {
  ArrowLeftIcon, CameraIcon, CheckCircleIcon, CheckIcon, MapPinIcon, NavigationArrowIcon, WarningIcon,
  StairsIcon, ChairIcon, UmbrellaIcon, WarningCircleIcon, TrafficSignIcon, MoonStarsIcon, ChatCircleTextIcon, type Icon,
} from '@phosphor-icons/react'
import type { Category } from '../categories.ts'

// The map is only fetched if GPS fails and someone taps "Pick on a map".
const PickMap = lazy(() => import('./PickMap.tsx'))

/** Seven plain choices; each maps onto an API category. The AI reads the photo and note for detail. */
const TILES: { key: Category; label: string; icon: Icon }[] = [
  { key: 'steps', label: 'Steps or steep slope', icon: StairsIcon },
  { key: 'no_seat', label: 'No place to sit', icon: ChairIcon },
  { key: 'no_shelter', label: 'No shelter from sun or rain', icon: UmbrellaIcon },
  { key: 'broken_path', label: 'Path broken or blocked', icon: WarningCircleIcon },
  { key: 'crossing', label: 'Hard to cross the road', icon: TrafficSignIcon },
  { key: 'dark', label: 'Too dark at night', icon: MoonStarsIcon },
  { key: 'other', label: 'Something else', icon: ChatCircleTextIcon },
]

// A place is GPS / map coordinates, a postal-code lookup (coordinates plus address), or just a typed address.
type Place = { lat: number; lng: number; accuracy?: number; hint?: string } | { hint: string }
type Gps = { state: 'finding' } | { state: 'ok'; lat: number; lng: number; accuracy: number; region: string | null } | { state: 'failed'; denied: boolean }
type Draft = { place: Place | null; photo: string | null; category: Category | null; note: string }
const SAVED = 'ss-report-unsent'
const load = (): Draft | null => { try { const s = localStorage.getItem(SAVED); return s ? JSON.parse(s) : null } catch { return null } }
const save = (d: Draft | null) => { try { if (d) localStorage.setItem(SAVED, JSON.stringify(d)); else localStorage.removeItem(SAVED) } catch { /* storage blocked: data stays on screen */ } }

/** Downscale to a 1600 px long edge as JPEG. Re-encoding through a canvas also drops EXIF, including GPS. */
async function shrink(file: File): Promise<string> {
  const bmp = await createImageBitmap(file)
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas')
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k)
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
  for (const q of [0.8, 0.7, 0.6, 0.5]) {
    const url = c.toDataURL('image/jpeg', q)
    if (url.length * 0.75 < 1.5e6) return url
  }
  return c.toDataURL('image/jpeg', 0.4)
}

export default function Report() {
  const [screen, setScreen] = useState<1 | 2 | 'done'>(1)
  const [photo, setPhoto] = useState<string | null>(null)
  const [category, setCategory] = useState<Category | null>(null)
  const [note, setNote] = useState('')
  const [noteOpen, setNoteOpen] = useState(false)
  const [gps, setGps] = useState<Gps>({ state: 'finding' })
  const [manual, setManual] = useState<Place | null>(null) // chosen by map pin or typed block when GPS fails
  const [where, setWhere] = useState<'chip' | 'ask' | 'map'>('chip')
  const [unsent, setUnsent] = useState<Draft | null>(load)
  const [sentId, setSentId] = useState<string | number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const head = useRef<HTMLHeadingElement>(null)
  const cam = useRef<HTMLInputElement>(null), gal = useRef<HTMLInputElement>(null)

  // Ask for the location quietly as soon as the page opens; most people never see a location step.
  // Some phones only prompt after a tap, so "Use my location" calls this again from the button.
  const locate = () => {
    if (!navigator.geolocation) { setGps({ state: 'failed', denied: false }); return }
    setGps({ state: 'finding' })
    navigator.geolocation.getCurrentPosition(async pos => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords
      let region: string | null = null
      try { const r = await fetch(`/api/regions/locate?lat=${lat}&lng=${lng}`); if (r.ok) region = (await r.json()).name ?? null } catch { /* name is optional */ }
      setManual(null); setGps({ state: 'ok', lat, lng, accuracy, region }); setWhere('chip')
    }, err => setGps({ state: 'failed', denied: err.code === err.PERMISSION_DENIED }), { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 })
  }
  useEffect(locate, [])
  useEffect(() => { head.current?.focus() }, [screen])

  // Postal code (6 digits) is looked up to coordinates; anything else is sent as a typed address.
  const [postal, setPostal] = useState('')
  const [found, setFound] = useState<string | null>(null)
  const [lookErr, setLookErr] = useState<string | null>(null)
  const [looking, setLooking] = useState(false)
  const lookup = async () => {
    const v = postal.trim()
    if (!v) return
    setLookErr(null); setFound(null)
    if (!/^\d{6}$/.test(v)) { setManual({ hint: v }); setWhere('chip'); return }
    setLooking(true)
    try {
      const r = await fetch(`/api/geocode?postal=${v}`)
      if (r.ok) {
        const g = await r.json()
        setFound(g.address); setManual({ lat: g.lat, lng: g.lng, hint: g.address }); setWhere('chip')
      } else setLookErr(r.status === 404 ? "We couldn't find that postal code. Please check it, or type the block and street." : 'Something went wrong. Please try again.')
    } catch { setLookErr("We couldn't reach the server. Please try again.") } finally { setLooking(false) }
  }

  const place: Place | null = manual ?? (gps.state === 'ok' ? { lat: gps.lat, lng: gps.lng, accuracy: gps.accuracy } : null)
  const go = (s: 1 | 2 | 'done') => { setError(null); setScreen(s); scrollTo(0, 0) }

  const pickFile = async (f: File | undefined) => {
    if (!f) return
    setBusy(true)
    try { setPhoto(await shrink(f)); go(2) } catch { setError('That photo could not be opened. Please try another one.') } finally { setBusy(false) }
  }

  const send = async () => {
    if (!category || !place) return
    setBusy(true); setError(null)
    const draft: Draft = { place, photo, category, note }
    const body = {
      ...('lat' in place
        ? { lat: place.lat, lng: place.lng, accuracy_m: place.accuracy ? Math.round(place.accuracy) : undefined, address_hint: place.hint }
        : { address_hint: place.hint }),
      category, description: note.trim() || undefined, photo: photo ?? undefined,
    }
    try {
      const r = await fetch('/api/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (r.ok) {
        setSentId((await r.json()).id); save(null); setUnsent(null); go('done')
      } else if (r.status === 503 && r.headers.get('x-silversteps') === 'backup') {
        save(draft); setError("Reports can't be sent right now. Please try again later. Your report is saved on this phone.")
      } else if (r.status === 413) {
        setError('The photo is too big. Please take it again, or send without a photo.')
      } else if (r.status === 422) {
        const j = await r.json().catch(() => null)
        const m = typeof j?.detail === 'string' ? j.detail : Array.isArray(j?.detail) ? j.detail[0]?.msg : null
        setError(`We couldn't accept this report${m ? `: ${String(m).replace(/^Value error,\s*/i, '')}` : ''}. Please check the place, then try again.`)
      } else {
        setError('Something went wrong. Please try again.')
      }
    } catch {
      save(draft); setError("We couldn't reach the server. Check your internet, then try again. Your report is saved on this phone.")
    } finally { setBusy(false) }
  }

  const resume = (d: Draft) => {
    setPhoto(d.photo); setCategory(d.category); setNote(d.note); setNoteOpen(!!d.note)
    if (d.place) setManual(d.place)
    go(2)
  }
  const restart = () => {
    setPhoto(null); setCategory(null); setNote(''); setNoteOpen(false); setManual(null); setPostal(''); setFound(null); setWhere('chip'); go(1)
  }

  const chipText = manual ? (manual.hint ? (found === manual.hint ? `Found: ${manual.hint}` : manual.hint) : 'Pinned on the map')
    : gps.state === 'ok' ? (gps.region ? `Near ${gps.region}` : 'Near you') : null
  // The "Where is it?" card shows until we have a place: GPS still pending, failed, or the user tapped Change.
  const showAsk = where === 'ask' || (where === 'chip' && !place)

  return (
    <main className="r-wrap">
      <header className="r-head">
        {screen === 2 && (
          <button type="button" className="r-back" onClick={() => go(1)} aria-label="Back to the photo"><ArrowLeftIcon size={26} /></button>
        )}
        <p className="r-title">Report a problem</p>
        {screen !== 'done' && <p className="r-progress">{screen} of 2</p>}
      </header>

      {screen === 1 && (
        <section className="r-stack" aria-labelledby="h1">
          {unsent && (
            <div className="r-card" role="status">
              <p>You have a report that was not sent yet.</p>
              <button type="button" className="r-btn r-primary" onClick={() => resume(unsent)}>Send it now</button>
            </div>
          )}
          <h1 id="h1" ref={head} tabIndex={-1}>Take a photo of the problem</h1>
          <input ref={cam} type="file" accept="image/*" capture="environment" hidden onChange={e => pickFile(e.target.files?.[0])} />
          <input ref={gal} type="file" accept="image/*" hidden onChange={e => pickFile(e.target.files?.[0])} />
          <button type="button" className="r-btn r-primary r-huge" onClick={() => cam.current?.click()} disabled={busy}>
            <CameraIcon aria-hidden size={36} />{busy ? 'Getting the photo ready' : 'Take a photo'}
          </button>
          <p className="r-muted r-center">Avoid faces and car plates.</p>
          {error && <p className="r-error" role="alert"><WarningIcon aria-hidden size={24} />{error}</p>}
          <button type="button" className="r-link r-center" onClick={() => gal.current?.click()}>Choose a photo instead</button>
          <button type="button" className="r-link r-center r-quiet" onClick={() => go(2)}>No photo? Continue</button>
        </section>
      )}

      {screen === 2 && (
        <section className="r-stack r-s2" aria-labelledby="h2">
          <h1 id="h2" ref={head} tabIndex={-1}>What is the problem?</h1>

          {where === 'map' ? (
            <Suspense fallback={<p className="r-muted">Loading the map</p>}>
              <PickMap start={gps.state === 'ok' ? [gps.lng, gps.lat] : null}
                onPick={([lng, lat]) => { setManual({ lat, lng }); setWhere('chip') }} onCancel={() => setWhere('chip')} />
            </Suspense>
          ) : showAsk ? (
            <div className="r-card">
              <p className="r-label">Where is it?</p>
              <p className="r-muted">So the Town Council knows where to look.</p>
              <button type="button" className="r-btn r-primary" onClick={locate} disabled={gps.state === 'finding'}>
                <NavigationArrowIcon aria-hidden size={26} />{gps.state === 'finding' ? 'Finding you…' : 'Use my location'}
              </button>
              {gps.state === 'failed' && gps.denied && (
                <p className="r-muted">Location is off. You can turn it on in your phone settings, or type the postal code.</p>
              )}
              <form className="r-postal" onSubmit={e => { e.preventDefault(); lookup() }}>
                <label htmlFor="postal" className="r-label">Postal code or block</label>
                <div className="r-row">
                  <input id="postal" className="r-input" inputMode="text" autoComplete="postal-code" value={postal}
                    onChange={e => { setPostal(e.target.value); setLookErr(null) }} aria-describedby="postal-ex" />
                  <button type="submit" className="r-btn r-find" disabled={!postal.trim() || looking}>{looking ? 'Finding' : 'Find'}</button>
                </div>
                <p id="postal-ex" className="r-muted">For example: 560314, or Blk 314 Ang Mo Kio Ave 3</p>
                {lookErr && <p className="r-error" role="alert"><WarningIcon aria-hidden size={24} />{lookErr}</p>}
              </form>
              <button type="button" className="r-link r-small" onClick={() => setWhere('map')}>Pick on a map</button>
            </div>
          ) : (
            <div className="r-top">
              {photo && <img src={photo} alt="Your photo" className="r-thumb" />}
              <p className="r-chip"><MapPinIcon aria-hidden size={22} /><span>{chipText}</span></p>
              <button type="button" className="r-link r-small" onClick={() => setWhere('ask')}>Change</button>
            </div>
          )}

          {(where === 'chip' || where === 'ask') && (
            <>
              <div className="r-tiles" role="radiogroup" aria-labelledby="h2">
                {TILES.map(t => (
                  <button key={t.key} type="button" role="radio" aria-checked={category === t.key} className="r-tile" onClick={() => setCategory(t.key)}>
                    <t.icon aria-hidden size={34} />
                    <span>{t.label}</span>
                    {category === t.key && <CheckIcon aria-hidden size={22} className="r-tick" />}
                  </button>
                ))}
              </div>
              {noteOpen ? (
                <div className="r-stack r-note">
                  <label htmlFor="note" className="r-label">Your note (optional)</label>
                  <textarea id="note" className="r-input" rows={3} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} aria-describedby="note-hint" autoFocus />
                  <p id="note-hint" className="r-muted">You can tap the microphone on your keyboard to speak.</p>
                </div>
              ) : (
                <button type="button" className="r-link" onClick={() => setNoteOpen(true)}>Add a note (optional)</button>
              )}
              {error && <p className="r-error" role="alert"><WarningIcon aria-hidden size={24} />{error}</p>}
              <div className="r-bar">
                <button type="button" className="r-btn r-primary r-send" onClick={send} disabled={!category || !place || busy}>
                  {busy ? 'Sending' : !category ? 'Choose a problem above' : !place ? (gps.state === 'finding' ? 'Finding where you are' : 'Tell us where it is') : 'Send report'}
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {screen === 'done' && (
        <section className="r-stack r-done" aria-labelledby="h-done">
          <CheckCircleIcon aria-hidden size={88} className="r-ok" />
          <h1 id="h-done" ref={head} tabIndex={-1}>Thank you. Your report is on the planners' map.</h1>
          <button type="button" className="r-btn r-primary r-huge" onClick={restart}>Report another</button>
          {sentId != null && <p className="r-muted r-tiny">Report number {sentId}</p>}
        </section>
      )}
    </main>
  )
}
