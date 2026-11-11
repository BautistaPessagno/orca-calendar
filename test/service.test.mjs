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
