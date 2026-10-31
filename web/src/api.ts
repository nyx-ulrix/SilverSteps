import type { Feedback, Route, Verdict, LngLat } from './logic.ts'

/** `backup` = the static backup copy answered (503 + x-silversteps: backup); saving is paused, not broken. */
export class ApiError extends Error {
  constructor(url: string, public backup: boolean) { super(`${url}: ${backup ? 'backup copy' : 'failed'}`) }
}
const isBackup = (r: Response) => r.status === 503 && r.headers.get('x-silversteps') === 'backup'

export async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new ApiError(url, isBackup(r))
  // Vite dev serves index.html for missing files; treat non-JSON as missing.
  if (!(r.headers.get('content-type') ?? '').includes('json')) throw new Error(`${url}: not found`)
  return r.json() as Promise<T>
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new ApiError(url, isBackup(r))
  return r.json() as Promise<T>
}

export const api = {
  health: () => getJSON<{ ok: boolean; db: unknown }>('/api/health'),
  feedback: (town: string) => getJSON<Feedback[]>(`/api/feedback?town=${encodeURIComponent(town)}`),
  routes: (town: string) => getJSON<Route[]>(`/api/routes?town=${encodeURIComponent(town)}`),
  sendFeedback: (b: { town: string; segment: string; gap?: string; barrier?: string; verdict: Verdict; note?: string }) =>
    post<Feedback>('/api/feedback', b),
  sendRoute: (b: { town: string; destination_type?: string; coords: LngLat[] }) => post<Route>('/api/routes', b),
}
