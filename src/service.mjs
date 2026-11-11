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
//     tasks        Task[] (docs/specs/tasks/spec.md): overdue and due in the days shown
//     taskLists    { id, title, shown }[]
//     tasksStatus  'ready' | 'off' | 'no-scope' | 'api-disabled' | 'error'
//     tasksMessage?
//   }
//
// Tasks are an extra: nothing on the tasks side changes status, message or events.
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

export function createService({ backends, taskSources = {}, taskAccess = async () => 'none', settings, storage, googleReady = async () => false, platform = process.platform, now = Date.now, timeZone, log = () => {} }) {
  let snapshot = null
  let lastLogged = null // the last failure logged, so a repeat of it isn't logged again
  let lastTasksLogged = null
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

  const NO_TASKS = { tasks: [], taskLists: [], tasksStatus: 'off' }

  // The tasks half of a snapshot. Never throws: whatever goes wrong becomes tasksStatus.
  async function readTasks(id, picked, today, end) {
    const source = taskSources[id]
    if (!source) return { ...NO_TASKS, access: 'none' }
    const access = await Promise.resolve(taskAccess(id)).catch(() => 'none')
    if (access !== 'read' && access !== 'write') return { ...NO_TASKS, tasksStatus: 'no-scope', access: 'none' }
    try {
      const taskLists = (await source.lists()).map((l) => ({ ...l, shown: typeof picked[`${id}:tasks:${l.id}`] === 'boolean' ? picked[`${id}:tasks:${l.id}`] : true }))
      const shown = taskLists.filter((l) => l.shown)
      const tasks = shown.length ? await source.tasks({ today, end, lists: shown }) : []
      lastTasksLogged = null
      return { tasks, taskLists, tasksStatus: 'ready', access }
    } catch (failure) {
      const error = toCalendarError(failure)
      const line = `${id}: tasks: ${error.message}`
      if (line !== lastTasksLogged) log(line)
      lastTasksLogged = line
      if (error.reason === 'scope') return { ...NO_TASKS, tasksStatus: 'no-scope', access: 'none' }
      if (error.reason === 'api-disabled') return { ...NO_TASKS, tasksStatus: 'api-disabled', tasksMessage: error.message, access }
      const keep = snapshot?.backend === id
      return { tasks: keep ? snapshot.tasks ?? [] : [], taskLists: keep ? snapshot.taskLists ?? [] : [], tasksStatus: 'error', tasksMessage: error.message, access }
    }
  }

  async function fetchSnapshot() {
    const id = await active()
    const backend = backends[id]
    const days = clampDays(await read('days'))
    const showDeclined = (await read('showDeclined')) === true
    // Answering invitations needs a backend that can, and the `rsvp` setting on.
    const rsvp = Boolean(backend.capabilities?.rsvp && backend.respond) && (await read('rsvp')) !== false
    const completeTasksOn = (await read('completeTasks')) !== false
    const base = { backend: id, days, showDeclined, capabilities: { ...(backend.capabilities ?? {}), rsvp, completeTasks: false }, fetchedAt: now(), ...NO_TASKS }
    const picked = await choices()
    const today = dayKey(now(), timeZone)
    // Started once the calendar list answered, so it runs next to the event reads; never when
    // the calendar needs setup.
    let tasksRead = null
    const startTasks = () => (tasksRead ??= readTasks(id, picked, today, addDays(today, days)))
    const withTasks = async (snap) => {
      const { access, ...part } = await startTasks()
      return { ...snap, ...part, capabilities: { ...snap.capabilities, completeTasks: access === 'write' && completeTasksOn && part.tasksStatus !== 'no-scope' } }
    }
    try {
      const calendars = (await backend.calendars()).map((c) => ({ ...c, shown: typeof picked[`${id}:${c.id}`] === 'boolean' ? picked[`${id}:${c.id}`] : c.selected !== false }))
      startTasks()
      const from = startOfDay(today, timeZone)
      const to = startOfDay(addDays(today, days), timeZone)
      const shown = calendars.filter((c) => c.shown)
      const events = shown.length ? await backend.events({ from, to, calendars: shown }) : []
      lastLogged = null
      return withTasks({ ...base, status: 'ready', calendars, events })
    } catch (failure) {
      const error = toCalendarError(failure)
      const line = `${id}: ${error.kind}: ${error.message}`
      if (line !== lastLogged) log(line)
      lastLogged = line
      const keep = !BLOCKING.has(error.kind) && snapshot?.backend === id
      const failed = {
        ...base,
        status: error.kind === 'invalid' ? 'error' : error.kind,
        message: error.message,
        calendars: keep ? snapshot.calendars : [],
        events: keep ? snapshot.events : [],
        ...(keep && snapshot.events.length ? { stale: true, fetchedAt: snapshot.fetchedAt } : {}),
        ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {})
      }
      return BLOCKING.has(error.kind) ? failed : withTasks(failed)
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

    async setTaskList(listId, shown) {
      const id = snapshot?.backend ?? (await active())
      const picked = { ...(await choices()), [`${id}:tasks:${String(listId).slice(0, 1024)}`]: Boolean(shown) }
      await storage.set(CHOICES_KEY, picked)
      generation++
    },

    // A press on a task's checkbox. The tick shows at once; the agenda is then read again.
    async completeTask(taskId, listId, done) {
      const snap = snapshot ?? (await this.load())
      const task = (snap.tasks ?? []).find((t) => t.id === taskId && t.listId === listId)
      if (!task) throw new CalendarError('invalid', 'That task isn’t in the agenda any more. Refresh and try again.')
      const source = taskSources[snap.backend]
      if (!source?.setDone || !['ready', 'error'].includes(snap.tasksStatus)) throw new CalendarError('invalid', 'This calendar source can’t tick off tasks.')
      if (!snap.capabilities?.completeTasks) {
        throw new CalendarError('invalid', (await read('completeTasks')) === false ? 'Turn on “Tick off tasks” in Orca Settings → Calendar to tick tasks from Orca.' : 'Your Google login can’t tick off tasks. Connect Google again and allow Google Tasks.')
      }
      const changed = await source.setDone(task, Boolean(done))
      snapshot = { ...snap, tasks: snap.tasks.map((t) => (t === task ? { ...t, done: changed?.done ?? Boolean(done), completedAt: changed?.completedAt ?? null } : t)) }
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
