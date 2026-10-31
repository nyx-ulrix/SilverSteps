// Resident report categories, shared by the companion site and the dashboard.
import type { Profile } from './logic.ts'

export type Category = 'steps' | 'no_shelter' | 'no_seat' | 'broken_path' | 'crossing' | 'dark' | 'blocked' | 'slope' | 'other'

/** label: plain words for residents; barrier: the dashboard barrier key whose icon it shares. */
export const CATEGORIES: { key: Category; label: string; barrier: string; profiles: Profile[] }[] = [
  { key: 'steps', label: 'Steps, no ramp', barrier: 'steps', profiles: ['mobility'] },
  { key: 'no_seat', label: 'No place to sit', barrier: 'rest_gap', profiles: ['mobility'] },
  { key: 'no_shelter', label: 'No shelter from sun or rain', barrier: 'no_shelter', profiles: ['mobility'] },
  { key: 'broken_path', label: 'Broken or uneven path', barrier: 'surface', profiles: ['mobility', 'sight'] },
  { key: 'crossing', label: 'Hard to cross the road', barrier: 'crossing', profiles: ['mobility', 'sight'] },
  { key: 'dark', label: 'Too dark at night', barrier: 'dark', profiles: ['sight'] },
  { key: 'blocked', label: 'Path blocked', barrier: 'obstruction', profiles: ['mobility', 'sight'] },
  { key: 'slope', label: 'Too steep', barrier: 'slope', profiles: ['mobility'] },
  { key: 'other', label: 'Something else', barrier: 'other', profiles: ['mobility', 'sight'] },
]
export const CAT = Object.fromEntries(CATEGORIES.map(c => [c.key, c])) as Record<Category, (typeof CATEGORIES)[number]>
export const catOf = (k: string) => CAT[k as Category] ?? CAT.other

export type ReportRow = { id: number | string; town: string | null; lat: number; lng: number; category: Category; description: string | null; address_hint?: string | null; has_photo: boolean; created: string }
export type Cluster = {
  id: string; lat: number; lng: number; count: number; categories: Record<string, number>; report_ids: (number | string)[]
  first: string; last: string
  /** true while Claude is still summarising this cluster */
  ai_pending?: boolean
  ai: { title: string; issue: string; severity: number; summary: string; suggested_fix: string; barrier: string } | null
}

/** "3 days ago", "today" */
export function ago(iso: string, now = Date.now()): string {
  const d = Math.floor((now - Date.parse(iso)) / 86400000)
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : d < 365 ? `${Math.floor(d / 30)} months ago` : `${Math.floor(d / 365)} years ago`
}
