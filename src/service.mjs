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
import { CalendarError, toCalendarError } from './errors.mjs'

export const BACKEND_IDS = Object.freeze(['google', 'eventkit', 'sample'])
const CHOICES_KEY = 'calendars'
// States in which there is nothing to show but the way to fix it.
export const BLOCKING = new Set(['needs-setup', 'unauthenticated', 'not-asked', 'no-access', 'unsupported'])

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
  let lastLogged = null // the last failure logged, so a repeat of it isn't logged again
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
    // Answering invitations needs a backend that can, and the `rsvp` setting on.
    const rsvp = Boolean(backend.capabilities?.rsvp && backend.respond) && (await read('rsvp')) !== false
    const base = { backend: id, days, showDeclined, capabilities: { ...(backend.capabilities ?? {}), rsvp }, fetchedAt: now() }
    try {
      const picked = await choices()
      const calendars = (await backend.calendars()).map((c) => ({ ...c, shown: typeof picked[`${id}:${c.id}`] === 'boolean' ? picked[`${id}:${c.id}`] : c.selected !== false }))
      const today = dayKey(now(), timeZone)
      const from = startOfDay(today, timeZone)
      const to = startOfDay(addDays(today, days), timeZone)
      const shown = calendars.filter((c) => c.shown)
      const events = shown.length ? await backend.events({ from, to, calendars: shown }) : []
      lastLogged = null
      return { ...base, status: 'ready', calendars, events }
    } catch (failure) {
      const error = toCalendarError(failure)
      const line = `${id}: ${error.kind}: ${error.message}`
      if (line !== lastLogged) log(line)
      lastLogged = line
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

  const notify = (next) => {
    for (const listener of listeners) {
      try {
        listener(next)
      } catch (error) {
        log(`listener: ${error.message}`)
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
          notify(next)
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

    // Accept, Maybe or Decline, pressed in the panel. The answer shows at once; the agenda is
    // then read again so it matches what Google kept.
    async respond(eventId, calendarId, response) {
      const snap = snapshot ?? (await this.load())
      const event = snap.events.find((e) => e.id === eventId && e.calendarId === calendarId)
      if (!event) throw new CalendarError('invalid', 'That event isn’t in the agenda any more. Refresh and try again.')
      const backend = backends[snap.backend]
      if (!backend?.respond || !backend.capabilities?.rsvp) throw new CalendarError('invalid', 'This calendar source can’t answer invitations. Connect Google Calendar to answer them from Orca.')
      if (!snap.capabilities?.rsvp) throw new CalendarError('invalid', 'Turn on “Answer invitations” in Orca Settings → Calendar to answer from Orca.')
      const answered = await backend.respond(event, response)
      const response_ = answered?.self?.response ?? response
      snapshot = { ...snap, events: snap.events.map((e) => (e === event ? { ...e, self: { ...e.self, response: response_ } } : e)) }
      notify(snapshot)
      generation++
      return this.load()
    },

    onChange(listener) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    }
  }
}
