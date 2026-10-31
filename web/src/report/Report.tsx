import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ArrowLeftIcon, CameraIcon, CheckCircleIcon, ImagesIcon, MapPinIcon, NavigationArrowIcon, WarningIcon } from '@phosphor-icons/react'
import { BarrierBadge } from '../Badge.tsx'
import { CATEGORIES, catOf, type Category } from '../categories.ts'

// The map is only fetched if someone taps "Pick on a map".
const PickMap = lazy(() => import('./PickMap.tsx'))

type Where = { lat: number; lng: number; accuracy?: number; region?: string | null } | { hint: string }
type Draft = { where: Where | null; photo: string | null; category: Category | null; description: string }
type Step = 'where' | 'photo' | 'what' | 'review' | 'done'
const EMPTY: Draft = { where: null, photo: null, category: null, description: '' }
const SAVED = 'ss-report-unsent'

const load = (): Draft | null => { try { const s = localStorage.getItem(SAVED); return s ? JSON.parse(s) : null } catch { return null } }
const save = (d: Draft | null) => { try { if (d) localStorage.setItem(SAVED, JSON.stringify(d)); else localStorage.removeItem(SAVED) } catch { /* storage full or blocked: data stays on screen */ } }

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
  const [step, setStep] = useState<Step>('where')
  const [d, setD] = useState<Draft>(EMPTY)
  const [unsent, setUnsent] = useState<Draft | null>(load)
  const [sent, setSent] = useState<{ id: string | number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const head = useRef<HTMLHeadingElement>(null)
  // Move focus to each new screen's heading so screen readers announce it.
  useEffect(() => { head.current?.focus() }, [step])

  const go = (s: Step) => { setError(null); setStep(s); scrollTo(0, 0) }
  const set = (p: Partial<Draft>) => setD(x => ({ ...x, ...p }))

  const send = async () => {
    setBusy(true); setError(null)
    const w = d.where!
    const body = {
      ...('hint' in w ? { address_hint: w.hint } : { lat: w.lat, lng: w.lng, accuracy_m: w.accuracy ? Math.round(w.accuracy) : undefined }),
      category: d.category, description: d.description.trim() || undefined, photo: d.photo ?? undefined,
    }
    try {
      const r = await fetch('/api/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (r.status === 503 && r.headers.get('x-silversteps') === 'backup') {
        save(d)
        setError("Reports can't be sent right now. Please try again later. Your report is saved on this phone.")
      } else if (!r.ok) {
        // 413: photo too big; 422: the server didn't accept the photo or the place (it says why in `detail`).
        const detail = r.status === 422 ? await r.json().then(j => {
          const d = j.detail
          const m = typeof d === 'string' ? d : Array.isArray(d) ? d[0]?.msg : null
          return typeof m === 'string' ? m.replace(/^Value error,\s*/i, '') : null
        }, () => null) : null
        setError(r.status === 413 ? 'The photo is too big. Please take it again or skip the photo.'
          : r.status === 422 ? `We couldn't accept this report${detail ? `: ${detail}` : ''}. Please check the place and photo, then try again.`
            : 'Something went wrong while sending. Please try again.')
      } else {
        const out = await r.json()
        save(null); setUnsent(null); setSent(out); go('done')
      }
    } catch {
      save(d)
      setError("We couldn't reach the server. Check your internet connection and try again. Your report is saved on this phone.")
    } finally { setBusy(false) }
  }

  const progress = step === 'where' ? 1 : step === 'photo' ? 2 : step === 'what' ? 3 : 0

  return (
    <main className="r-wrap">
      <header className="r-head">
        <p className="r-brand">SilverSteps</p>
        {progress > 0 && <p className="r-progress" aria-live="polite">Step {progress} of 3</p>}
        {step === 'review' && <p className="r-progress">Check and send</p>}
      </header>

      {step === 'where' && (
        <>
          {unsent && (
            <div className="r-card r-unsent" role="status">
              <p>You have a report that was not sent yet.</p>
              <button type="button" className="r-btn r-primary" onClick={() => { setD(unsent); go('review') }}>Open it</button>
            </div>
          )}
          <Where head={head} onDone={w => { set({ where: w }); go('photo') }} current={d.where} />
        </>
      )}
      {step === 'photo' && (
        <Photo head={head} photo={d.photo} onPhoto={p => set({ photo: p })} onBack={() => go('where')} onNext={() => go('what')} />
      )}
      {step === 'what' && (
        <What head={head} d={d} set={set} onBack={() => go('photo')} onNext={() => go('review')} />
      )}
      {step === 'review' && (
        <section className="r-stack" aria-labelledby="h-review">
          <h1 id="h-review" ref={head} tabIndex={-1}>Check your report</h1>
          <div className="r-card r-summary">
            <p><strong>Where:</strong> {d.where && ('hint' in d.where ? d.where.hint : d.where.region ? `Near ${d.where.region}` : 'Your location')}</p>
            <p className="r-cat-line">
              <strong>Problem:</strong>
              {d.category && <><BarrierBadge barrier={catOf(d.category).barrier} severity={2} size={22} />{catOf(d.category).label}</>}
            </p>
            {d.description.trim() && <p><strong>What you said:</strong> {d.description.trim()}</p>}
            {d.photo ? <img src={d.photo} alt="Your photo" className="r-preview" /> : <p><strong>Photo:</strong> none</p>}
          </div>
          {error && <p className="r-error" role="alert"><WarningIcon aria-hidden size={24} />{error}</p>}
          <button type="button" className="r-btn r-primary" onClick={send} disabled={busy || !d.where || !d.category}>
            {busy ? 'Sending' : 'Send report'}
          </button>
          <button type="button" className="r-btn" onClick={() => go('what')}>Change something</button>
        </section>
      )}
      {step === 'done' && (
        <section className="r-stack r-done" aria-labelledby="h-done">
          <CheckCircleIcon aria-hidden size={64} className="r-ok" />
          <h1 id="h-done" ref={head} tabIndex={-1}>Thank you. Your report has been sent.</h1>
          <p>Your report number is <strong>{sent?.id}</strong>.</p>
          <p>The Town Council can see it on the SilverSteps map.</p>
          <button type="button" className="r-btn r-primary" onClick={() => { setD(EMPTY); setSent(null); go('where') }}>Report another</button>
        </section>
      )}
    </main>
  )
}

function Where({ head, onDone, current }: { head: React.Ref<HTMLHeadingElement>; onDone: (w: Where) => void; current: Where | null }) {
  const [state, setState] = useState<'idle' | 'finding' | 'found' | 'failed' | 'map' | 'type'>(current ? 'found' : 'idle')
  const [where, setWhere] = useState<Where | null>(current)
  const [hint, setHint] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const locate = () => {
    if (!navigator.geolocation) { setState('failed'); setMsg('This phone cannot share its location. Please pick on a map or type the address.'); return }
    setState('finding'); setMsg(null)
    navigator.geolocation.getCurrentPosition(async pos => {
      const w = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, region: null as string | null }
      try {
        const r = await fetch(`/api/regions/locate?lat=${w.lat}&lng=${w.lng}`)
        if (r.ok) w.region = (await r.json()).name ?? null
      } catch { /* region name is a nice-to-have */ }
      setWhere(w); setState('found')
    }, err => {
      setState('failed')
      setMsg(err.code === err.PERMISSION_DENIED
        ? 'Location is turned off for this page. You can pick the place on a map or type the address instead.'
        : 'We could not find your location. Please try again, pick on a map, or type the address.')
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 })
  }

  return (
    <section className="r-stack" aria-labelledby="h-where">
      <h1 id="h-where" ref={head} tabIndex={-1}>Where is the problem?</h1>
      <p className="r-why">So the Town Council knows where to look.</p>

      {state === 'found' && where && 'lat' in where ? (
        <div className="r-card" role="status">
          <p className="r-found"><MapPinIcon aria-hidden size={28} />{where.region ? `Found you near ${where.region}.` : 'Found your location.'}</p>
          {where.accuracy != null && <p className="r-muted">Accurate to about {Math.round(where.accuracy)} metres.</p>}
          <button type="button" className="r-btn r-primary" onClick={() => onDone(where)}>Yes, this is the place</button>
          <button type="button" className="r-btn" onClick={() => setState('map')}>Move the pin on a map</button>
        </div>
      ) : state === 'map' ? (
        <Suspense fallback={<p className="r-muted">Loading the map</p>}>
          <PickMap start={where && 'lat' in where ? [where.lng, where.lat] : null}
            onPick={([lng, lat]) => onDone({ lat, lng })} onCancel={() => setState(where ? 'found' : 'idle')} />
        </Suspense>
      ) : state === 'type' ? (
        <form className="r-stack" onSubmit={e => { e.preventDefault(); if (hint.trim()) onDone({ hint: hint.trim() }) }}>
          <label htmlFor="hint" className="r-label">Block number and street</label>
          <input id="hint" className="r-input" value={hint} onChange={e => setHint(e.target.value)} autoComplete="street-address" placeholder="" aria-describedby="hint-help" />
          <p id="hint-help" className="r-muted">For example: Blk 314 Ang Mo Kio Ave 3</p>
          <button type="submit" className="r-btn r-primary" disabled={!hint.trim()}>Next</button>
          <button type="button" className="r-btn" onClick={() => setState('idle')}>Back</button>
        </form>
      ) : (
        <>
          <button type="button" className="r-btn r-primary r-big" onClick={locate} disabled={state === 'finding'}>
            <NavigationArrowIcon aria-hidden size={28} />{state === 'finding' ? 'Finding you' : 'Use my location'}
          </button>
          {msg && <p className="r-error" role="alert"><WarningIcon aria-hidden size={24} />{msg}</p>}
          <button type="button" className="r-btn" onClick={() => setState('map')}><MapPinIcon aria-hidden size={24} />Pick on a map</button>
          <button type="button" className="r-btn" onClick={() => setState('type')}>Type the address</button>
        </>
      )}
    </section>
  )
}

function Photo({ head, photo, onPhoto, onBack, onNext }: {
  head: React.Ref<HTMLHeadingElement>; photo: string | null; onPhoto: (p: string | null) => void; onBack: () => void; onNext: () => void
}) {
  const cam = useRef<HTMLInputElement>(null), gal = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const pick = async (f: File | undefined) => {
    if (!f) return
    setBusy(true); setErr(null)
    try { onPhoto(await shrink(f)) } catch { setErr('That photo could not be opened. Please try another one.') } finally { setBusy(false) }
  }
  return (
    <section className="r-stack" aria-labelledby="h-photo">
      <h1 id="h-photo" ref={head} tabIndex={-1}>Add a photo</h1>
      <p className="r-why">A photo helps them see the problem. Please avoid people's faces and car plates.</p>
      <input ref={cam} type="file" accept="image/*" capture="environment" hidden onChange={e => pick(e.target.files?.[0])} />
      <input ref={gal} type="file" accept="image/*" hidden onChange={e => pick(e.target.files?.[0])} />
      {photo ? (
        <>
          <img src={photo} alt="Your photo" className="r-preview" />
          <button type="button" className="r-btn r-primary" onClick={onNext}>Use this photo</button>
          <button type="button" className="r-btn" onClick={() => cam.current?.click()}><CameraIcon aria-hidden size={24} />Retake</button>
          <button type="button" className="r-btn" onClick={() => onPhoto(null)}>Remove photo</button>
        </>
      ) : (
        <>
          <button type="button" className="r-btn r-primary r-big" onClick={() => cam.current?.click()} disabled={busy}>
            <CameraIcon aria-hidden size={28} />{busy ? 'Getting the photo ready' : 'Take a photo'}
          </button>
          <button type="button" className="r-btn" onClick={() => gal.current?.click()} disabled={busy}><ImagesIcon aria-hidden size={24} />Choose from gallery</button>
          <button type="button" className="r-btn" onClick={onNext}>Skip photo</button>
        </>
      )}
      {err && <p className="r-error" role="alert"><WarningIcon aria-hidden size={24} />{err}</p>}
      <button type="button" className="r-link" onClick={onBack}><ArrowLeftIcon aria-hidden size={20} />Back</button>
    </section>
  )
}

function What({ head, d, set, onBack, onNext }: {
  head: React.Ref<HTMLHeadingElement>; d: Draft; set: (p: Partial<Draft>) => void; onBack: () => void; onNext: () => void
}) {
  return (
    <section className="r-stack" aria-labelledby="h-what">
      <h1 id="h-what" ref={head} tabIndex={-1}>What is the problem?</h1>
      <div className="r-cats" role="radiogroup" aria-labelledby="h-what">
        {CATEGORIES.map(c => (
          <button key={c.key} type="button" role="radio" aria-checked={d.category === c.key} className="r-cat" onClick={() => set({ category: c.key })}>
            <BarrierBadge barrier={c.barrier} severity={2} size={26} />
            <span>{c.label}</span>
          </button>
        ))}
      </div>
      <label htmlFor="desc" className="r-label">Tell us more (you can skip this)</label>
      <textarea id="desc" className="r-input" rows={4} maxLength={1000} value={d.description}
        onChange={e => set({ description: e.target.value })} aria-describedby="desc-count" />
      <p id="desc-count" className="r-muted">{1000 - d.description.length} letters left</p>
      <button type="button" className="r-btn r-primary" onClick={onNext} disabled={!d.category}>Next</button>
      {!d.category && <p className="r-muted">Choose one problem to continue.</p>}
      <button type="button" className="r-link" onClick={onBack}><ArrowLeftIcon aria-hidden size={20} />Back</button>
    </section>
  )
}
