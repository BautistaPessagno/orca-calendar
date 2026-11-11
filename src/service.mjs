// The worker's one source of truth: which backend is active, which calendars are shown, and the
// last agenda read. The panel, the status bar and the reminders all read from here.
//
//   Snapshot {
//     backend      'google' | 'eventkit' | 'sample'
//     status       'ready' | 'needs-setup' | 'unauthenticated' | 'not-asked' | 'no-access'
//                  | 'unsupported' | 'offline' | 'rate-limited' | 'error'
//     message?     the sentence to show for any status but 'ready'
//     calendars    Calendar & { shown }
//     events       Event[] of the shown calendars, today and the next `days - 1` days
//     stale?       true when `events` are from an earlier read because this one failed
//     fetchedAt, days, showDeclined, capabilities
//   }
import { addDays, dayKey, startOfDay } from '../shared/agenda.mjs'
import { toCalendarError } from './errors.mjs'

export const BACKEND_IDS = Object.freeze(['google', 'eventkit', 'sample'])
const CHOICES_KEY = 'calendars'
// States in which there is nothing to show but the way to fix it.
const BLOCKING = new Set(['needs-setup', 'unauthenticated', 'not-asked', 'no-access', 'unsupported'])

export function resolveBackendId(choice, platform, { googleReady } = {}) {
  if (BACKEND_IDS.includes(choice)) return choice
  if (googleReady) return 'google'
  return platform === 'darwin' ? 'eventkit' : 'google'
}

const clampDays = (value) => {
  const n = Math.round(Number(value))
  return Number.isFinite(n) && n >= 1 ? Math.min(14, n) : 3
}

export function createService({ backends, settings, storage, googleReady = async () => false, platform = process.platform, now = Date.now, timeZone, log = () => {} }) {
  let snapshot = null
  let loading = null
  let loadingGeneration = -1
  // Rises when what a read depends on changes (backend, calendars), so a read already running
  // with the old choice is not reused.
  let generation = 0
  const listeners = new Set()

  const read = (key) => Promise.resolve(settings.get(key)).catch(() => undefined)

  const choices = async () => {
    const stored = await Promise.resolve(storage.get(CHOICES_KEY)).catch(() => null)
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
  }

  const active = async () => {
    const choice = await read('backend')
    const id = resolveBackendId(choice, platform, { googleReady: choice === 'auto' || choice === undefined ? await googleReady() : false })
    return backends[id] ? id : 'sample'
  }

  async function fetchSnapshot() {
    const id = await active()
    const backend = backends[id]
    const days = clampDays(await read('days'))
    const showDeclined = (await read('showDeclined')) === true
    const base = { backend: id, days, showDeclined, capabilities: backend.capabilities ?? {}, fetchedAt: now() }
    try {
      const picked = await choices()
      const calendars = (await backend.calendars()).map((c) => ({ ...c, shown: typeof picked[`${id}:${c.id}`] === 'boolean' ? picked[`${id}:${c.id}`] : c.selected !== false }))
      const today = dayKey(now(), timeZone)
      const from = startOfDay(today, timeZone)
      const to = startOfDay(addDays(today, days), timeZone)
      const shown = calendars.filter((c) => c.shown)
      const events = shown.length ? await backend.events({ from, to, calendars: shown }) : []
      return { ...base, status: 'ready', calendars, events }
    } catch (failure) {
      const error = toCalendarError(failure)
      log(`${id}: ${error.kind}: ${error.message}`)
      const keep = !BLOCKING.has(error.kind) && snapshot?.backend === id
      return {
        ...base,
        status: error.kind === 'invalid' ? 'error' : error.kind,
        message: error.message,
        calendars: keep ? snapshot.calendars : [],
        events: keep ? snapshot.events : [],
        ...(keep && snapshot.events.length ? { stale: true, fetchedAt: snapshot.fetchedAt } : {}),
        ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {})
      }
    }
  }

  return {
    get snapshot() {
      return snapshot
    },

    // Reads the calendar now. Concurrent calls share one read.
    load() {
      if (loading && loadingGeneration === generation) return loading
      const mine = generation
      loadingGeneration = mine
      const run = (loading = fetchSnapshot()
        .then((next) => {
          // A newer read started meanwhile: let it be the one that counts.
          if (mine !== generation) return loading ?? next
          snapshot = next
          for (const listener of listeners) {
            try {
              listener(next)
            } catch (error) {
              log(`listener: ${error.message}`)
            }
          }
          return next
        })
        .finally(() => {
          if (loading === run) loading = null
        }))
      return run
    },

    async setCalendar(calendarId, shown) {
      const id = snapshot?.backend ?? (await active())
      const picked = { ...(await choices()), [`${id}:${String(calendarId).slice(0, 1024)}`]: Boolean(shown) }
      await storage.set(CHOICES_KEY, picked)
      generation++
    },

    async select(id) {
      if (id !== 'auto' && !BACKEND_IDS.includes(id)) throw new Error(`Unknown backend: ${id}`)
      await settings.set('backend', id)
      snapshot = null
      generation++
    },

    onChange(listener) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    }
  }
}
