// Calendar worker: reads the calendar through the backend the settings pick, answers the
// sidebar panel, keeps the status bar item counting down to the next meeting, and shows the
// reminders. The status bar item keeps this worker running while the plugin is enabled.
//
// Panel requests (orca.plugin.request):
//   agenda.get        { refresh? }           → Snapshot (src/service.mjs)
//   calendars.set     { id, shown }          → Snapshot
//   backend.select    { backend }            → Snapshot; 'auto' | 'google' | 'eventkit' | 'sample'
//   prefs.set         { key, value }         → Snapshot; key 'days' | 'showDeclined'
//   auth.info                                → Google connection (no secrets)
//   auth.start        { clientId, clientSecret } → { url }
//   auth.status                              → { status, message? }
//   auth.disconnect                          → Snapshot
//   eventkit.request                         → Snapshot, after macOS's prompt
//   event.respond     { id, calendarId, response } → Snapshot; 'accepted' | 'tentative' | 'declined'
//   tasks.lists.set   { id, shown }          → Snapshot
//   task.complete     { id, listId, done }   → Snapshot
// Posts: 'agenda.changed' { fetchedAt } whenever a new snapshot is read.
import { createEventKitBackend } from './backends/eventkit/backend.mjs'
import { createAuth } from './backends/google/auth.mjs'
import { createGoogleBackend } from './backends/google/backend.mjs'
import { createClient } from './backends/google/client.mjs'
import { TASKS_BASE, createGoogleTasks } from './backends/google/tasks.mjs'
import { createSampleBackend, createSampleTasks } from './backends/sample.mjs'
import { createReminders } from './src/reminders.mjs'
import { BLOCKING, createService } from './src/service.mjs'
import { createTicker } from './src/status-bar.mjs'

// How often the agenda is re-read while the plugin is enabled.
export const REFRESH_MS = { google: 5 * 60_000, eventkit: 2 * 60_000, sample: 5 * 60_000 }
const RETRY_MS = 60_000
// Setup states (connect Google, allow Mac access) change only when the person acts, and each
// action re-reads at once; this slow re-read only catches a change made outside Orca.
const BLOCKED_RETRY_MS = 15 * 60_000
const RESPONSES = ['accepted', 'tentative', 'declined']
const PREFS = { days: (v) => Math.max(1, Math.min(14, Math.round(Number(v)) || 3)), showDeclined: (v) => v === true }

let stopAll = null

export default function activate(orca, deps = {}) {
  const log = (message) => orca.log?.(message)
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? setTimeout
  const clearTimer = deps.clearTimer ?? clearTimeout

  const auth =
    deps.auth ??
    createAuth({
      settings: orca.settings,
      secrets: orca.secrets,
      protection: async () => (await orca.host.call('secrets.protection')).status,
      fetchImpl: deps.fetchImpl
    })
  const backends = deps.backends ?? {
    google: createGoogleBackend({ client: createClient({ auth, fetchImpl: deps.fetchImpl }), log }),
    eventkit: createEventKitBackend(),
    sample: createSampleBackend({ now })
  }
  // Google Tasks: shown when the login has a Tasks scope (docs/specs/tasks/spec.md).
  const taskSources = deps.taskSources ?? {
    google: createGoogleTasks({ client: createClient({ auth, fetchImpl: deps.fetchImpl, base: TASKS_BASE, api: 'Google Tasks' }), log }),
    sample: createSampleTasks({ now })
  }
  const taskAccess = async (id) => (id === 'google' ? ((await auth.connection().catch(() => null))?.tasks ?? 'none') : 'write')
  const setting = (key) => Promise.resolve(orca.settings.get(key)).catch(() => undefined)
  const rsvpWanted = async () => (await setting('rsvp')) !== false
  const completeTasksWanted = async () => (await setting('completeTasks')) !== false

  const googleReady = async () => {
    const info = await auth.connection().catch(() => null)
    return Boolean(info?.clientId && info.connected)
  }
  const service = createService({ backends, taskSources, taskAccess, settings: orca.settings, storage: orca.storage, googleReady, platform: deps.platform, now, log })

  let reminderSettings = { notify: true, notifyMinutes: 5 }
  const reminders = createReminders({ host: orca.host, storage: orca.storage, log })
  const ticker = createTicker({
    host: orca.host,
    now,
    setTimer,
    clearTimer,
    log,
    onTick: (events, t) => reminders.check(events, t, reminderSettings),
    extraWake: (events, t) => reminders.nextAt(events, t, reminderSettings)
  })

  let refreshTimer = null
  const scheduleRefresh = (snapshot) => {
    clearTimer(refreshTimer)
    const ms = snapshot.status === 'ready' ? REFRESH_MS[snapshot.backend] : BLOCKING.has(snapshot.status) ? BLOCKED_RETRY_MS : snapshot.retryAfterMs ?? RETRY_MS
    refreshTimer = setTimer(() => void service.load(), ms)
    refreshTimer?.unref?.()
  }

  service.onChange((snapshot) => {
    scheduleRefresh(snapshot)
    void (async () => {
      const notify = await setting('notify')
      const notifyMinutes = await setting('notifyMinutes')
      reminderSettings = { notify: notify !== false, notifyMinutes: Number.isFinite(Number(notifyMinutes)) ? Number(notifyMinutes) : 5, showDeclined: false }
      await ticker.update(snapshot.events, {})
    })().catch((error) => log(`ticker: ${error.message}`))
    try {
      orca.panels.post('agenda.changed', { fetchedAt: snapshot.fetchedAt, backend: snapshot.backend, status: snapshot.status })
    } catch (error) {
      log(`post: ${error.message}`)
    }
  })

  const current = async ({ refresh = false } = {}) => {
    const snap = service.snapshot
    if (!refresh && snap && now() - snap.fetchedAt < (REFRESH_MS[snap.backend] ?? RETRY_MS)) return snap
    return service.load()
  }

  const handlers = {
    'agenda.get': (input) => current({ refresh: input?.refresh === true }),
    'calendars.set': async (input) => {
      await service.setCalendar(String(input?.id ?? ''), input?.shown === true)
      return service.load()
    },
    'backend.select': async (input) => {
      await service.select(String(input?.backend ?? ''))
      return service.load()
    },
    'prefs.set': async (input) => {
      const clean = PREFS[input?.key]
      if (!clean) throw Object.assign(new Error('Unknown preference'), { code: 'invalid' })
      await orca.settings.set(input.key, clean(input.value))
      return service.load()
    },
    'auth.info': async () => ({
      ...(await auth.connection({ rsvp: await rsvpWanted() })),
      rsvp: await rsvpWanted(),
      completeTasks: await completeTasksWanted(),
      platform: deps.platform ?? process.platform
    }),
    'auth.start': async (input) => auth.start({ clientId: input?.clientId, clientSecret: input?.clientSecret, rsvp: await rsvpWanted(), completeTasks: await completeTasksWanted() }),
    'auth.status': async () => {
      const status = await auth.status()
      if (status.status === 'connected' && service.snapshot?.status !== 'ready') await service.load()
      return status
    },
    'auth.disconnect': async () => {
      await auth.disconnect()
      return service.load()
    },
    // Only from a press on Yes, Maybe or No in the panel.
    'event.respond': async (input) => {
      if (!RESPONSES.includes(input?.response)) throw Object.assign(new Error('Answer yes, maybe or no.'), { code: 'invalid' })
      return service.respond(String(input?.id ?? ''), String(input?.calendarId ?? ''), input.response)
    },
    'tasks.lists.set': async (input) => {
      await service.setTaskList(String(input?.id ?? ''), input?.shown === true)
      return service.load()
    },
    // Only from a press on a task's checkbox in the panel.
    'task.complete': async (input) => {
      if (typeof input?.done !== 'boolean') throw Object.assign(new Error('Say whether the task is done.'), { code: 'invalid' })
      return service.completeTask(String(input?.id ?? ''), String(input?.listId ?? ''), input.done)
    },
    'eventkit.request': async () => {
      await backends.eventkit.requestAccess()
      return service.load()
    }
  }
  for (const [name, handler] of Object.entries(handlers)) {
    orca.panels.handle(name, async (input) => {
      try {
        return await handler(input)
      } catch (error) {
        // The panel shows `message` as is; the code tells it what kind of failure it was.
        throw Object.assign(new Error(error.message), { code: error.code ?? error.kind ?? 'action_failed' })
      }
    })
  }

  orca.settings.onDidChange?.(({ key } = {}) => {
    if (['clientId', 'redirectPort'].includes(key)) return
    void service.load()
  })

  void service.load()

  stopAll = () => {
    clearTimer(refreshTimer)
    ticker.stop()
    auth.close?.()
  }
}

export function deactivate() {
  stopAll?.()
  stopAll = null
}
