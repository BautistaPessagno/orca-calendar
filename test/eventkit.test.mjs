import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEventKitBackend, normalizeEventKit } from '../backends/eventkit/backend.mjs'

const calendar = { id: 'CAL-1', title: 'Work', color: '#33b679', account: 'Google' }
const raw = {
  id: 'EK-1',
  calendarId: 'CAL-1',
  title: 'Planning',
  allDay: false,
  start: Date.parse('2026-11-11T14:00:00Z'),
  end: Date.parse('2026-11-11T15:00:00Z'),
  timeZone: 'America/New_York',
  location: 'Room 4',
  url: null,
  notes: 'Join: https://acme.zoom.us/j/81234567890?pwd=abc\nAgenda: roadmap',
  attendees: [
    { name: 'Lee Park', email: 'lee@example.com', response: 'accepted', self: false, role: 3, type: 1 },
    { name: 'Sam Rivera', email: 'sam@example.com', response: 'needsAction', self: true, role: 1, type: 1 },
    { name: 'Room 4', email: null, response: 'accepted', self: false, role: 1, type: 3 },
    { name: 'Kai', email: 'kai@example.com', response: 'declined', self: false, role: 2, type: 1 }
  ],
  organizer: { name: 'Lee Park', email: 'lee@example.com', response: 'accepted', self: false, role: 3, type: 1 },
  status: 1,
  availability: 0,
  recurring: true
}

test('normalizes an EventKit occurrence', () => {
  const event = normalizeEventKit(raw, calendar, { timeZone: 'UTC' })
  assert.equal(event.id, `EK-1@${raw.start}`)
  assert.equal(event.color, '#33b679')
  assert.equal(event.start, raw.start)
  assert.deepEqual(event.conference, { kind: 'zoom', url: 'https://acme.zoom.us/j/81234567890?pwd=abc', label: 'Zoom' })
  assert.deepEqual(event.self, { response: 'needsAction', email: 'sam@example.com' })
  assert.deepEqual(event.attendees.map((a) => [a.name, a.response, a.optional]), [
    ['Lee Park', 'accepted', false],
    ['Sam Rivera', 'needsAction', false],
    ['Kai', 'declined', true]
  ])
  assert.equal(event.room, 'Room 4')
  assert.equal(event.busy, true)
  assert.equal(event.recurring, true)
  assert.equal(event.description, raw.notes)
})

test('all-day occurrences become dates with an exclusive end; free and tentative are read', () => {
  const allDay = normalizeEventKit(
    { ...raw, allDay: true, start: Date.parse('2026-11-11T00:00:00Z'), end: Date.parse('2026-11-12T23:59:59Z'), availability: 1, status: 2, attendees: [], organizer: null },
    calendar,
    { timeZone: 'UTC' }
  )
  assert.equal(allDay.start, '2026-11-11')
  assert.equal(allDay.end, '2026-11-13')
  assert.equal(allDay.busy, false)
  assert.equal(allDay.status, 'tentative')
  assert.equal(allDay.self, null)
})

test('the organizer is "accepted" when it is the person', () => {
  const event = normalizeEventKit({ ...raw, attendees: [], organizer: { ...raw.organizer, self: true } }, calendar, { timeZone: 'UTC' })
  assert.deepEqual(event.self, { response: 'accepted', email: 'lee@example.com' })
})

test('cancelled occurrences are dropped', () => {
  assert.equal(normalizeEventKit({ ...raw, status: 3 }, calendar, { timeZone: 'UTC' }), null)
})

function runnerWith(answers) {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    const answer = answers[args[0]]
    if (answer instanceof Error) throw answer
    return JSON.stringify(typeof answer === 'function' ? answer(args) : answer)
  }
  return { run, calls }
}

test('reports access states without asking', async () => {
  for (const [status, kind] of [
    ['notDetermined', 'not-asked'],
    ['denied', 'no-access'],
    ['restricted', 'no-access'],
    ['writeOnly', 'no-access']
  ]) {
    const { run } = runnerWith({ calendars: { status } })
    const backend = createEventKitBackend({ run, platform: 'darwin' })
    await assert.rejects(backend.calendars(), (e) => e.kind === kind)
  }
})

test('reads calendars and the events of the asked ones', async () => {
  const { run, calls } = runnerWith({
    calendars: { status: 'fullAccess', calendars: [{ ...calendar, type: 1 }, { id: 'CAL-2', title: 'Birthdays', color: null, account: 'Other', type: 4 }] },
    events: { status: 'fullAccess', events: [raw] }
  })
  const backend = createEventKitBackend({ run, platform: 'darwin', timeZone: 'UTC' })
  const calendars = await backend.calendars()
  assert.deepEqual(calendars.map((c) => [c.id, c.title, c.color, c.account, c.selected]), [
    ['CAL-1', 'Work', '#33b679', 'Google', true],
    ['CAL-2', 'Birthdays', '#8e8e93', 'Other', false]
  ])
  const events = await backend.events({ from: 1, to: 2, calendars: [calendars[0]] })
  assert.equal(events.length, 1)
  assert.deepEqual(calls.at(-1), ['events', '1', '2', JSON.stringify(['CAL-1'])])
})

test('asks for access once, on request', async () => {
  const { run, calls } = runnerWith({ request: { status: 'fullAccess' } })
  const backend = createEventKitBackend({ run, platform: 'darwin' })
  assert.equal(await backend.requestAccess(), 'fullAccess')
  assert.deepEqual(calls[0], ['request', '60000'])
})

test('off macOS it says so without running osascript', async () => {
  const { run, calls } = runnerWith({})
  const backend = createEventKitBackend({ run, platform: 'linux' })
  await assert.rejects(backend.calendars(), (e) => e.kind === 'unsupported')
  assert.equal(calls.length, 0)
})

test('a script error or a timeout becomes a sentence', async () => {
  const backend = createEventKitBackend({ run: runnerWith({ calendars: { error: 'boom' } }).run, platform: 'darwin' })
  await assert.rejects(backend.calendars(), /boom/)
  const slow = createEventKitBackend({ run: runnerWith({ calendars: Object.assign(new Error('timed out'), { killed: true }) }).run, platform: 'darwin' })
  await assert.rejects(slow.calendars(), (e) => e.kind === 'error' && /10 seconds/.test(e.message))
})
