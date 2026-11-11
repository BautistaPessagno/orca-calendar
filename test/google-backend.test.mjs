import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGoogleBackend, normalizeEvent, plainText } from '../backends/google/backend.mjs'
import { createClient } from '../backends/google/client.mjs'
import { CAL, fakeGoogle, reply } from './fakes.mjs'

const calendar = { id: 'sam@example.com', title: 'Sam Rivera', color: '#039be5', primary: true }

const meeting = {
  id: 'evt1_20261111T093000Z',
  status: 'confirmed',
  summary: 'Standup',
  start: { dateTime: '2026-11-11T10:30:00+01:00', timeZone: 'Europe/Madrid' },
  end: { dateTime: '2026-11-11T10:45:00+01:00', timeZone: 'Europe/Madrid' },
  recurringEventId: 'evt1',
  hangoutLink: 'https://meet.google.com/abc-defg-hij',
  conferenceData: { conferenceSolution: { name: 'Google Meet', key: { type: 'hangoutsMeet' } }, entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }] },
  organizer: { email: 'lee@example.com', displayName: 'Lee Park' },
  attendees: [
    { email: 'lee@example.com', displayName: 'Lee Park', organizer: true, responseStatus: 'accepted' },
    { email: 'sam@example.com', self: true, responseStatus: 'tentative' },
    { email: 'room-4@resource.calendar.google.com', displayName: 'Room 4', resource: true, responseStatus: 'accepted' },
    { email: 'kai@example.com', optional: true, responseStatus: 'needsAction' }
  ],
  description: '<b>Agenda</b><br>1. Updates&nbsp;&amp; blockers<br><a href="https://example.com/doc">Notes</a>',
  htmlLink: 'https://www.google.com/calendar/event?eid=abc',
  eventType: 'default'
}

test('normalizes a timed Google event', () => {
  const event = normalizeEvent(meeting, calendar)
  assert.equal(event.id, 'evt1_20261111T093000Z')
  assert.equal(event.calendarId, 'sam@example.com')
  assert.equal(event.title, 'Standup')
  assert.equal(event.allDay, false)
  assert.equal(event.start, Date.parse('2026-11-11T09:30:00Z'))
  assert.equal(event.end, Date.parse('2026-11-11T09:45:00Z'))
  assert.equal(event.timeZone, 'Europe/Madrid')
  assert.equal(event.color, '#039be5')
  assert.equal(event.recurring, true)
  assert.equal(event.busy, true)
  assert.deepEqual(event.conference, { kind: 'meet', url: 'https://meet.google.com/abc-defg-hij', label: 'Google Meet' })
  assert.deepEqual(event.self, { response: 'tentative', email: 'sam@example.com' })
  assert.deepEqual(event.organizer, { name: 'Lee Park', email: 'lee@example.com', self: false })
  assert.deepEqual(
    event.attendees.map((a) => [a.name, a.response, a.self, a.organizer, a.optional]),
    [
      ['Lee Park', 'accepted', false, true, false],
      ['sam@example.com', 'tentative', true, false, false],
      ['kai@example.com', 'needsAction', false, false, true]
    ]
  )
  assert.equal(event.room, 'Room 4')
  assert.equal(event.description, 'Agenda\n1. Updates & blockers\nNotes')
  assert.equal(event.htmlLink, 'https://www.google.com/calendar/event?eid=abc')
})

test('all-day events keep their dates; event colours, free time and kinds are read', () => {
  const event = normalizeEvent({ id: 'a', summary: 'Offsite', start: { date: '2026-11-11' }, end: { date: '2026-11-13' }, colorId: '11', transparency: 'transparent', eventType: 'outOfOffice' }, calendar)
  assert.equal(event.allDay, true)
  assert.equal(event.start, '2026-11-11')
  assert.equal(event.end, '2026-11-13')
  assert.equal(event.color, '#d50000')
  assert.equal(event.busy, false)
  assert.equal(event.kind, 'outOfOffice')
  assert.equal(event.self, null)
})

test('drops working-location events, untitled ones become "Busy", private ones say so', () => {
  assert.equal(normalizeEvent({ id: 'w', eventType: 'workingLocation', start: { date: '2026-11-11' }, end: { date: '2026-11-12' } }, calendar), null)
  assert.equal(normalizeEvent({ id: 'b', start: { dateTime: '2026-11-11T10:00:00Z' }, end: { dateTime: '2026-11-11T11:00:00Z' } }, calendar).title, '(No title)')
  assert.equal(normalizeEvent({ id: 'p', visibility: 'private', start: { dateTime: '2026-11-11T10:00:00Z' }, end: { dateTime: '2026-11-11T11:00:00Z' } }, calendar).title, 'Busy')
})

test('plainText turns event HTML into readable text and caps it', () => {
  assert.equal(plainText('<p>Hi<br/>there</p><ul><li>one</li><li>two</li></ul>'), 'Hi\nthere\none\ntwo')
  assert.equal(plainText('a &lt;b&gt; &quot;c&quot; &#39;d&#39;'), 'a <b> "c" \'d\'')
  assert.equal(plainText('x'.repeat(5000)).length, 2000)
})

const calendarList = {
  items: [
    { id: 'sam@example.com', summary: 'sam@example.com', primary: true, backgroundColor: '#039be5', selected: true, accessRole: 'owner' },
    { id: 'team@group.calendar.google.com', summary: 'Team', summaryOverride: 'Team rota', backgroundColor: '#33b679', selected: true, accessRole: 'reader' },
    { id: 'holidays@group.v.calendar.google.com', summary: 'Holidays', backgroundColor: '#7986cb', selected: false, accessRole: 'reader' }
  ]
}

function backendWith(routes, token = async () => 'tok') {
  const google = fakeGoogle(routes)
  const client = createClient({ auth: { getAccessToken: token, expire: async () => {} }, fetchImpl: google.fetchImpl })
  return { backend: createGoogleBackend({ client }), google }
}

test('lists calendars with their Google colours and whether Google shows them', async () => {
  const { backend, google } = backendWith({ [`GET ${CAL}/users/me/calendarList`]: reply(200, calendarList) })
  const calendars = await backend.calendars()
  assert.deepEqual(calendars, [
    { id: 'sam@example.com', title: 'sam@example.com', color: '#039be5', primary: true, selected: true, account: 'Google' },
    { id: 'team@group.calendar.google.com', title: 'Team rota', color: '#33b679', primary: false, selected: true, account: 'Google' },
    { id: 'holidays@group.v.calendar.google.com', title: 'Holidays', color: '#7986cb', primary: false, selected: false, account: 'Google' }
  ])
  assert.equal(google.requests[0].headers.authorization, 'Bearer tok')
})

test('reads each asked calendar with recurring events expanded, following pages', async () => {
  const from = Date.parse('2026-11-11T00:00:00Z')
  const to = Date.parse('2026-11-14T00:00:00Z')
  const { backend, google } = backendWith({
    [`GET ${CAL}/users/me/calendarList`]: reply(200, calendarList),
    [`GET ${CAL}/calendars/sam@example.com/events`]: [reply(200, { items: [meeting], nextPageToken: 'p2' }), reply(200, { items: [{ ...meeting, id: 'evt2', summary: 'Retro' }] })],
    [`GET ${CAL}/calendars/team@group.calendar.google.com/events`]: reply(200, { items: [{ ...meeting, id: 'evt3', summary: 'Rota', attendees: undefined }] })
  })
  const calendars = await backend.calendars()
  const events = await backend.events({ from, to, calendars: calendars.slice(0, 2) })
  assert.deepEqual(events.map((e) => [e.id, e.calendarId, e.color]), [
    ['evt1_20261111T093000Z', 'sam@example.com', '#039be5'],
    ['evt2', 'sam@example.com', '#039be5'],
    ['evt3', 'team@group.calendar.google.com', '#33b679']
  ])
  const first = google.requests.find((r) => r.key.endsWith('sam@example.com/events'))
  assert.equal(first.query.singleEvents, 'true')
  assert.equal(first.query.orderBy, 'startTime')
  assert.equal(first.query.timeMin, '2026-11-11T00:00:00.000Z')
  assert.equal(first.query.timeMax, '2026-11-14T00:00:00.000Z')
  assert.equal(google.requests.filter((r) => r.key.endsWith('sam@example.com/events'))[1].query.pageToken, 'p2')
  assert.ok(!google.requests.some((r) => r.key.includes('holidays')))
})

test('a calendar that fails to read does not hide the others', async () => {
  const { backend } = backendWith({
    [`GET ${CAL}/calendars/sam@example.com/events`]: reply(200, { items: [meeting] }),
    [`GET ${CAL}/calendars/team@group.calendar.google.com/events`]: reply(404, { error: { code: 404, message: 'Not Found' } })
  })
  const events = await backend.events({ from: 0, to: 1, calendars: [calendar, { id: 'team@group.calendar.google.com', color: '#000' }] })
  assert.equal(events.length, 1)
})

test('client: a 401 refreshes the token once, then gives up as unauthenticated', async () => {
  let forced = 0
  const google = fakeGoogle({ [`GET ${CAL}/users/me/calendarList`]: [reply(401, {}), reply(200, { items: [] })] })
  const client = createClient({ auth: { getAccessToken: async ({ force } = {}) => (force && forced++, 'tok'), expire: async () => {} }, fetchImpl: google.fetchImpl })
  assert.deepEqual(await client.get('/users/me/calendarList'), { items: [] })
  assert.equal(forced, 1)
  let expired = false
  const always401 = fakeGoogle({ [`GET ${CAL}/users/me/calendarList`]: reply(401, {}) })
  const client2 = createClient({ auth: { getAccessToken: async () => 'tok', expire: async () => (expired = true) }, fetchImpl: always401.fetchImpl })
  await assert.rejects(client2.get('/users/me/calendarList'), (e) => e.kind === 'unauthenticated')
  assert.equal(expired, true)
})

test('client: rate limits, a disabled API, admin blocks and no network become sentences', async () => {
  const make = (r) => createClient({ auth: { getAccessToken: async () => 'tok', expire: async () => {} }, fetchImpl: fakeGoogle({ [`GET ${CAL}/x`]: r }).fetchImpl })
  await assert.rejects(make(reply(429, {})).get('/x'), (e) => e.kind === 'rate-limited')
  await assert.rejects(make(reply(403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } })).get('/x'), (e) => e.kind === 'rate-limited')
  await assert.rejects(
    make(reply(403, { error: { errors: [{ reason: 'accessNotConfigured' }], message: 'Google Calendar API has not been used in project 123 before or it is disabled.' } })).get('/x'),
    (e) => e.kind === 'error' && /Enable the Google Calendar API/.test(e.message)
  )
  await assert.rejects(make(new TypeError('fetch failed')).get('/x'), (e) => e.kind === 'offline')
})
