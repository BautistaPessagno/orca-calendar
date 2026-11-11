import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createService, resolveBackendId } from '../src/service.mjs'
import { CalendarError } from '../src/errors.mjs'
import { fakeSettings, fakeStorage } from './fakes.mjs'

test('auto picks Google once connected, the Mac until then, Google off macOS', () => {
  assert.equal(resolveBackendId('auto', 'darwin', { googleReady: true }), 'google')
  assert.equal(resolveBackendId('auto', 'darwin', { googleReady: false }), 'eventkit')
  assert.equal(resolveBackendId('auto', 'linux', { googleReady: false }), 'google')
  assert.equal(resolveBackendId(undefined, 'darwin', { googleReady: false }), 'eventkit')
  assert.equal(resolveBackendId('eventkit', 'linux', {}), 'eventkit')
  assert.equal(resolveBackendId('sample', 'darwin', {}), 'sample')
  assert.equal(resolveBackendId('bogus', 'darwin', { googleReady: true }), 'google')
})

const cal = (id, extra = {}) => ({ id, title: id, color: '#039be5', primary: false, selected: true, account: 'Test', ...extra })
const ev = (id, calendarId, start, end) => ({ id, calendarId, title: id, allDay: false, start, end, status: 'confirmed', busy: true, attendees: [], self: null })

function fakeBackend(id, { calendars = [cal('a'), cal('b'), cal('c', { selected: false })], events = [], fail } = {}) {
  const reads = []
  return {
    reads,
    id,
    capabilities: { rsvp: false },
    calendars: async () => {
      if (fail) throw fail
      return calendars
    },
    events: async (query) => {
      reads.push(query)
      return events.filter((e) => query.calendars.some((c) => c.id === e.calendarId))
    }
  }
}

function setup({ settings = {}, storage = {}, backends, googleReady = false, now = () => Date.parse('2026-11-11T09:00:00Z') } = {}) {
  backends ??= { google: fakeBackend('google'), eventkit: fakeBackend('eventkit'), sample: fakeBackend('sample') }
  return {
    backends,
    service: createService({
      backends,
      settings: fakeSettings({ backend: 'eventkit', ...settings }),
      storage: fakeStorage(storage),
      googleReady: async () => googleReady,
      platform: 'darwin',
      now,
      timeZone: 'UTC'
    })
  }
}

test('reads the shown calendars for today and the next days', async () => {
  const { service, backends } = setup({ settings: { days: 2 } })
  const snap = await service.load()
  assert.equal(snap.backend, 'eventkit')
  assert.equal(snap.status, 'ready')
  assert.deepEqual(snap.calendars.map((c) => [c.id, c.shown]), [['a', true], ['b', true], ['c', false]])
  const read = backends.eventkit.reads[0]
  assert.deepEqual(read.calendars.map((c) => c.id), ['a', 'b'])
  assert.equal(read.from, Date.parse('2026-11-11T00:00:00Z'))
  assert.equal(read.to, Date.parse('2026-11-13T00:00:00Z'))
  assert.equal(snap.days, 2)
})

test('the calendar picker overrides what the account shows, and sticks', async () => {
  const storage = {}
  const { service, backends } = setup({ storage })
  await service.load()
  await service.setCalendar('c', true)
  await service.setCalendar('a', false)
  const snap = await service.load()
  assert.deepEqual(snap.calendars.map((c) => [c.id, c.shown]), [['a', false], ['b', true], ['c', true]])
  assert.deepEqual(backends.eventkit.reads.at(-1).calendars.map((c) => c.id), ['b', 'c'])
})

test('keeps the last agenda when a read fails, and says why', async () => {
  const events = [ev('x', 'a', Date.parse('2026-11-11T10:00:00Z'), Date.parse('2026-11-11T11:00:00Z'))]
  const backend = fakeBackend('eventkit', { events })
  const { service } = setup({ backends: { eventkit: backend, google: fakeBackend('google'), sample: fakeBackend('sample') } })
  assert.equal((await service.load()).events.length, 1)
  backend.calendars = async () => {
    throw new CalendarError('offline', 'Can’t reach it.')
  }
  const snap = await service.load()
  assert.equal(snap.status, 'offline')
  assert.equal(snap.message, 'Can’t reach it.')
  assert.equal(snap.events.length, 1)
  assert.equal(snap.stale, true)
})

test('a setup state replaces the agenda', async () => {
  const backend = fakeBackend('google', { fail: new CalendarError('needs-setup', 'Connect your Google account.') })
  const { service } = setup({ settings: { backend: 'google' }, backends: { google: backend, eventkit: fakeBackend('eventkit'), sample: fakeBackend('sample') } })
  const snap = await service.load()
  assert.equal(snap.status, 'needs-setup')
  assert.deepEqual(snap.events, [])
})

test('switching backends forgets the other backend’s agenda', async () => {
  const { service } = setup()
  await service.load()
  await service.select('sample')
  const snap = await service.load()
  assert.equal(snap.backend, 'sample')
})

test('listeners hear each new agenda', async () => {
  const { service } = setup()
  const heard = []
  service.onChange((snap) => heard.push(snap.backend))
  await service.load()
  assert.deepEqual(heard, ['eventkit'])
})

test('a switch while a read runs starts a new read with the new backend', async () => {
  let release
  const slow = fakeBackend('eventkit')
  const gate = new Promise((r) => (release = r))
  const calendars = slow.calendars
  slow.calendars = async () => (await gate, calendars())
  const { service } = setup({ backends: { eventkit: slow, google: fakeBackend('google'), sample: fakeBackend('sample') } })
  const first = service.load()
  await service.select('sample')
  const second = service.load()
  release()
  assert.equal((await second).backend, 'sample')
  await first
  assert.equal(service.snapshot.backend, 'sample')
})

test('respond: answers through the backend, shows the answer at once, then re-reads', async () => {
  const events = [{ ...ev('inv', 'a', Date.parse('2026-11-11T10:00:00Z'), Date.parse('2026-11-11T11:00:00Z')), self: { response: 'needsAction', email: 'me@example.com' } }]
  const backend = fakeBackend('google', { events })
  backend.capabilities = { rsvp: true }
  const answers = []
  backend.respond = async (event, response) => (answers.push([event.id, response]), { ...event, self: { ...event.self, response } })
  const { service } = setup({ settings: { backend: 'google', rsvp: true }, backends: { google: backend, eventkit: fakeBackend('eventkit'), sample: fakeBackend('sample') } })
  await service.load()
  const heard = []
  service.onChange((s) => heard.push(s.events[0].self.response))
  await service.respond('inv', 'a', 'accepted')
  assert.deepEqual(answers, [['inv', 'accepted']])
  assert.equal(heard[0], 'accepted')
})

test('respond: refused when the backend or the setting does not allow it', async () => {
  const events = [{ ...ev('inv', 'a', 1, 2), self: { response: 'needsAction' } }]
  const mac = fakeBackend('eventkit', { events })
  const { service } = setup({ backends: { eventkit: mac, google: fakeBackend('google'), sample: fakeBackend('sample') } })
  await service.load()
  await assert.rejects(service.respond('inv', 'a', 'accepted'), /can’t answer/)
  const google = fakeBackend('google', { events })
  google.capabilities = { rsvp: true }
  google.respond = async () => assert.fail('must not answer')
  const off = setup({ settings: { backend: 'google', rsvp: false }, backends: { google, eventkit: mac, sample: fakeBackend('sample') } }).service
  const snap = await off.load()
  assert.equal(snap.capabilities.rsvp, false)
  await assert.rejects(off.respond('inv', 'a', 'accepted'), /Answer invitations/)
})

test('a failure is logged once, not again on every read that fails the same way', async () => {
  const logs = []
  const backend = fakeBackend('google', { fail: new CalendarError('needs-setup', 'Connect your Google account.') })
  const service = createService({
    backends: { google: backend, eventkit: fakeBackend('eventkit'), sample: fakeBackend('sample') },
    settings: fakeSettings({ backend: 'google' }),
    storage: fakeStorage(),
    platform: 'darwin',
    timeZone: 'UTC',
    log: (line) => logs.push(line)
  })
  await service.load()
  await service.load()
  await service.load()
  assert.equal(logs.length, 1)
  backend.calendars = async () => {
    throw new CalendarError('offline', 'Can’t reach it.')
  }
  await service.load()
  assert.equal(logs.length, 2)
})

// ---------- Google Tasks: an extra that never changes the calendar's own state ----------

const task = (id, listId, due, extra = {}) => ({ id, listId, listTitle: listId, title: id, notes: null, due, done: false, completedAt: null, parentId: null, assigned: false, link: null, ...extra })

function fakeTasks({ lists = [{ id: 'l1', title: 'My Tasks' }, { id: 'l2', title: 'Errands' }], tasks = [], fail } = {}) {
  const reads = []
  const done = []
  return {
    reads,
    done,
    lists: async () => {
      if (fail) throw fail
      return lists
    },
    tasks: async (query) => {
      reads.push(query)
      return tasks.filter((t) => query.lists.some((l) => l.id === t.listId))
    },
    setDone: async (t, value) => (done.push([t.id, value]), { ...t, done: value })
  }
}

function setupTasks({ access = 'write', source = fakeTasks(), settings = {}, storage = {}, backend } = {}) {
  backend ??= fakeBackend('google', { events: [ev('meet', 'a', Date.parse('2026-11-11T10:00:00Z'), Date.parse('2026-11-11T11:00:00Z'))] })
  const accessCalls = []
  const service = createService({
    backends: { google: backend, eventkit: fakeBackend('eventkit'), sample: fakeBackend('sample') },
    taskSources: { google: source },
    taskAccess: async (id) => (accessCalls.push(id), access),
    settings: fakeSettings({ backend: 'google', days: 3, ...settings }),
    storage: fakeStorage(storage),
    platform: 'darwin',
    now: () => Date.parse('2026-11-11T09:00:00Z'),
    timeZone: 'UTC'
  })
  return { service, source, accessCalls }
}

test('tasks: read with the agenda when the login has a Tasks scope', async () => {
  const source = fakeTasks({ tasks: [task('report', 'l1', '2026-11-11'), task('milk', 'l2', '2026-11-12')] })
  const { service } = setupTasks({ source })
  const snap = await service.load()
  assert.equal(snap.status, 'ready')
  assert.equal(snap.events.length, 1)
  assert.equal(snap.tasksStatus, 'ready')
  assert.deepEqual(snap.tasks.map((t) => t.id), ['report', 'milk'])
  assert.deepEqual(snap.taskLists, [{ id: 'l1', title: 'My Tasks', shown: true }, { id: 'l2', title: 'Errands', shown: true }])
  assert.deepEqual({ today: source.reads[0].today, end: source.reads[0].end }, { today: '2026-11-11', end: '2026-11-14' })
  assert.equal(snap.capabilities.completeTasks, true)
})

test('tasks: a login without a Tasks scope reads no tasks and changes nothing else', async () => {
  const source = fakeTasks({ tasks: [task('report', 'l1', '2026-11-11')] })
  const { service } = setupTasks({ access: 'none', source })
  const snap = await service.load()
  assert.equal(snap.status, 'ready')
  assert.equal(snap.message, undefined)
  assert.equal(snap.events.length, 1)
  assert.equal(snap.tasksStatus, 'no-scope')
  assert.deepEqual(snap.tasks, [])
  assert.equal(source.reads.length, 0)
  assert.equal(snap.capabilities.completeTasks, false)
})

test('tasks: a source with no Tasks at all (Mac calendars) is "off"', async () => {
  const { service } = setupTasks()
  await service.select('eventkit')
  const snap = await service.load()
  assert.equal(snap.tasksStatus, 'off')
  assert.deepEqual(snap.tasks, [])
})

test('tasks: a disabled Tasks API leaves the calendar as it is and says how to turn it on', async () => {
  const fail = new CalendarError('error', 'Enable the Google Tasks API in your Google Cloud project.', { reason: 'api-disabled' })
  const { service } = setupTasks({ source: fakeTasks({ fail }) })
  const snap = await service.load()
  assert.equal(snap.status, 'ready')
  assert.equal(snap.message, undefined)
  assert.equal(snap.events.length, 1)
  assert.equal(snap.tasksStatus, 'api-disabled')
  assert.match(snap.tasksMessage, /Google Tasks API/)
})

test('tasks: a Tasks permission Google refuses counts as no scope, not as an ended login', async () => {
  const fail = new CalendarError('unauthenticated', 'Calendar needs a permission.', { reason: 'scope' })
  const snap = await setupTasks({ source: fakeTasks({ fail }) }).service.load()
  assert.equal(snap.status, 'ready')
  assert.equal(snap.tasksStatus, 'no-scope')
})

test('tasks: a failed read keeps the last tasks and leaves the calendar status alone', async () => {
  const source = fakeTasks({ tasks: [task('report', 'l1', '2026-11-11')] })
  const { service } = setupTasks({ source })
  await service.load()
  source.lists = async () => {
    throw new CalendarError('offline', 'Can’t reach Google.')
  }
  const snap = await service.load()
  assert.equal(snap.status, 'ready')
  assert.equal(snap.tasksStatus, 'error')
  assert.equal(snap.tasksMessage, 'Can’t reach Google.')
  assert.deepEqual(snap.tasks.map((t) => t.id), ['report'])
})

test('tasks: a calendar that needs setup reads no tasks', async () => {
  const backend = fakeBackend('google', { fail: new CalendarError('needs-setup', 'Connect your Google account.') })
  const { service, source } = setupTasks({ backend })
  const snap = await service.load()
  assert.equal(snap.status, 'needs-setup')
  assert.equal(snap.tasksStatus, 'off')
  assert.deepEqual(snap.tasks, [])
  assert.equal(source.reads.length, 0)
})

test('tasks: hiding a task list sticks and leaves it out of the read', async () => {
  const storage = {}
  const source = fakeTasks({ tasks: [task('report', 'l1', '2026-11-11'), task('milk', 'l2', '2026-11-11')] })
  const { service } = setupTasks({ source, storage })
  await service.load()
  await service.setTaskList('l2', false)
  const snap = await service.load()
  assert.deepEqual(snap.taskLists.map((l) => [l.id, l.shown]), [['l1', true], ['l2', false]])
  assert.deepEqual(source.reads.at(-1).lists.map((l) => l.id), ['l1'])
  assert.deepEqual(snap.tasks.map((t) => t.id), ['report'])
  assert.equal(storage.calendars['google:tasks:l2'], false)
})

test('tasks: ticking one done shows at once, then re-reads', async () => {
  const source = fakeTasks({ tasks: [task('report', 'l1', '2026-11-11')] })
  const { service } = setupTasks({ source })
  await service.load()
  const heard = []
  service.onChange((s) => heard.push(s.tasks[0]?.done))
  await service.completeTask('report', 'l1', true)
  assert.deepEqual(source.done, [['report', true]])
  assert.equal(heard[0], true)
})

test('tasks: no checkbox with a read-only login or with the setting off', async () => {
  const source = fakeTasks({ tasks: [task('report', 'l1', '2026-11-11')] })
  source.setDone = async () => assert.fail('must not write')
  const read = setupTasks({ access: 'read', source }).service
  assert.equal((await read.load()).capabilities.completeTasks, false)
  await assert.rejects(read.completeTask('report', 'l1', true), /can’t tick/)
  const off = setupTasks({ source, settings: { completeTasks: false } }).service
  assert.equal((await off.load()).capabilities.completeTasks, false)
  await assert.rejects(off.completeTask('report', 'l1', true), /Tick off tasks/)
})
