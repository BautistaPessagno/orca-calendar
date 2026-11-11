import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAgenda, dayKey, meetingState, startOfDay } from '../shared/agenda.mjs'

const TZ = 'Europe/Madrid'
const at = (iso) => Date.parse(iso)
const ev = (id, start, end, extra = {}) => ({
  id,
  calendarId: 'work',
  title: id,
  allDay: false,
  start: at(start),
  end: at(end),
  status: 'confirmed',
  busy: true,
  attendees: [],
  self: null,
  ...extra
})
const allDay = (id, start, end, extra = {}) => ({ ...ev(id, 0, 0), allDay: true, start, end, ...extra })

test('day keys and midnights follow the time zone, across a DST change', () => {
  assert.equal(dayKey(at('2026-11-10T23:30:00Z'), TZ), '2026-11-11')
  assert.equal(startOfDay('2026-11-11', TZ), at('2026-11-10T23:00:00Z'))
  // Spain leaves summer time on 2026-10-25: that day lasts 25 hours.
  assert.equal(startOfDay('2026-10-25', TZ), at('2026-10-24T22:00:00Z'))
  assert.equal(startOfDay('2026-10-26', TZ), at('2026-10-25T23:00:00Z'))
})

test('lists the next days in order, all-day events first, the current one marked', () => {
  const now = at('2026-11-11T09:10:00Z') // 10:10 in Madrid
  const events = [
    ev('review', '2026-11-11T09:00:00Z', '2026-11-11T10:00:00Z'),
    ev('standup', '2026-11-11T08:30:00Z', '2026-11-11T08:45:00Z'),
    allDay('offsite', '2026-11-11', '2026-11-13'),
    ev('lunch', '2026-11-12T12:00:00Z', '2026-11-12T13:00:00Z')
  ]
  const agenda = buildAgenda(events, { now, days: 3, timeZone: TZ })
  assert.deepEqual(agenda.days.map((d) => d.date), ['2026-11-11', '2026-11-12', '2026-11-13'])
  const [today, tomorrow, after] = agenda.days
  assert.deepEqual(today.allDay.map((e) => e.id), ['offsite'])
  assert.deepEqual(today.items.filter((i) => i.type === 'event').map((i) => i.event.id), ['standup', 'review'])
  assert.deepEqual(agenda.current, ['review'])
  assert.equal(today.today, true)
  assert.deepEqual(tomorrow.allDay.map((e) => e.id), ['offsite']) // end date is exclusive
  assert.deepEqual(after.allDay, [])
  assert.deepEqual(after.items, [])
  assert.equal(today.items.find((i) => i.type === 'now').at, now)
})

test('the now line sits between the events around it', () => {
  const now = at('2026-11-11T08:50:00Z')
  const agenda = buildAgenda([ev('a', '2026-11-11T08:30:00Z', '2026-11-11T08:45:00Z'), ev('b', '2026-11-11T09:00:00Z', '2026-11-11T09:20:00Z')], {
    now,
    days: 1,
    timeZone: TZ,
    minGapMs: 60 * 60_000
  })
  assert.deepEqual(agenda.days[0].items.map((i) => i.type + (i.event ? ':' + i.event.id : '')), ['event:a', 'now', 'event:b'])
})

test('shows free time of 30 minutes or more between meetings, from now on', () => {
  const now = at('2026-11-11T08:00:00Z')
  const events = [
    ev('a', '2026-11-11T09:00:00Z', '2026-11-11T10:00:00Z'),
    ev('b', '2026-11-11T10:15:00Z', '2026-11-11T11:00:00Z'), // 15 min gap: none
    ev('free', '2026-11-11T11:00:00Z', '2026-11-11T12:00:00Z', { busy: false }), // "free" events don't block
    ev('c', '2026-11-11T13:00:00Z', '2026-11-11T14:00:00Z')
  ]
  const gaps = buildAgenda(events, { now, days: 1, timeZone: TZ }).days[0].items.filter((i) => i.type === 'gap')
  assert.deepEqual(
    gaps.map((g) => [g.start, g.end]),
    [
      [now, at('2026-11-11T09:00:00Z')],
      [at('2026-11-11T11:00:00Z'), at('2026-11-11T13:00:00Z')]
    ]
  )
})

test('no free time in the past', () => {
  const now = at('2026-11-11T12:00:00Z')
  const events = [ev('a', '2026-11-11T08:00:00Z', '2026-11-11T09:00:00Z'), ev('b', '2026-11-11T11:00:00Z', '2026-11-11T11:30:00Z'), ev('c', '2026-11-11T13:00:00Z', '2026-11-11T14:00:00Z')]
  const gaps = buildAgenda(events, { now, days: 1, timeZone: TZ }).days[0].items.filter((i) => i.type === 'gap')
  assert.deepEqual(gaps.map((g) => [g.start, g.end]), [[now, at('2026-11-11T13:00:00Z')]])
})

test('a meeting past midnight shows on both days, marked as continuing', () => {
  const now = at('2026-11-11T08:00:00Z')
  const agenda = buildAgenda([ev('late', '2026-11-11T22:30:00Z', '2026-11-12T00:30:00Z')], { now, days: 2, timeZone: TZ })
  const first = agenda.days[0].items.find((i) => i.type === 'event')
  const second = agenda.days[1].items.find((i) => i.type === 'event')
  assert.equal(first.continues, true)
  assert.equal(second.continued, true)
})

test('leaves out hidden calendars, cancelled and declined events unless asked', () => {
  const now = at('2026-11-11T08:00:00Z')
  const events = [
    ev('mine', '2026-11-11T09:00:00Z', '2026-11-11T10:00:00Z'),
    ev('hidden', '2026-11-11T09:00:00Z', '2026-11-11T10:00:00Z', { calendarId: 'family' }),
    ev('declined', '2026-11-11T11:00:00Z', '2026-11-11T12:00:00Z', { self: { response: 'declined' } }),
    ev('cancelled', '2026-11-11T11:00:00Z', '2026-11-11T12:00:00Z', { status: 'cancelled' })
  ]
  const ids = (agenda) => agenda.days[0].items.filter((i) => i.type === 'event').map((i) => i.event.id)
  assert.deepEqual(ids(buildAgenda(events, { now, days: 1, timeZone: TZ, hidden: ['family'] })), ['mine'])
  assert.deepEqual(ids(buildAgenda(events, { now, days: 1, timeZone: TZ, hidden: ['family'], showDeclined: true })), ['mine', 'declined'])
})

test('meetingState: the running meeting, the next one, and what counts', () => {
  const events = [
    allDay('holiday', '2026-11-11', '2026-11-12'),
    ev('standup', '2026-11-11T09:00:00Z', '2026-11-11T09:15:00Z'),
    ev('focus', '2026-11-11T09:30:00Z', '2026-11-11T11:00:00Z', { busy: false }),
    ev('nope', '2026-11-11T09:40:00Z', '2026-11-11T10:00:00Z', { self: { response: 'declined' } }),
    ev('review', '2026-11-11T10:00:00Z', '2026-11-11T11:00:00Z', { self: { response: 'tentative' } })
  ]
  assert.deepEqual(meetingState(events, at('2026-11-11T08:00:00Z')), { current: null, next: events[1] })
  assert.deepEqual(meetingState(events, at('2026-11-11T09:05:00Z')), { current: events[1], next: events[4] })
  assert.deepEqual(meetingState(events, at('2026-11-11T11:00:00Z')), { current: null, next: null })
  assert.equal(meetingState(events, at('2026-11-11T08:00:00Z'), { hidden: ['work'] }).next, null)
})

test('free time sits before a "free" event that starts inside it', () => {
  const now = at('2026-11-11T08:00:00Z')
  const events = [
    ev('a', '2026-11-11T09:00:00Z', '2026-11-11T10:00:00Z'),
    ev('focus', '2026-11-11T10:30:00Z', '2026-11-11T12:00:00Z', { busy: false }),
    ev('b', '2026-11-11T13:00:00Z', '2026-11-11T14:00:00Z')
  ]
  const order = buildAgenda(events, { now, days: 1, timeZone: TZ }).days[0].items.map((i) => i.type + (i.event ? ':' + i.event.id : ''))
  assert.deepEqual(order, ['now', 'gap', 'event:a', 'gap', 'event:focus', 'event:b'])
})

test('later days: free time between meetings only', () => {
  const now = at('2026-11-11T08:00:00Z')
  const events = [ev('a', '2026-11-12T09:00:00Z', '2026-11-12T10:00:00Z'), ev('b', '2026-11-12T11:00:00Z', '2026-11-12T12:00:00Z')]
  const order = buildAgenda(events, { now, days: 2, timeZone: TZ }).days[1].items.map((i) => i.type)
  assert.deepEqual(order, ['event', 'gap', 'event'])
})

const tk = (id, due, extra = {}) => ({ id, listId: 'l1', listTitle: 'My Tasks', title: id, notes: null, due, done: false, completedAt: null, parentId: null, assigned: false, link: null, ...extra })

test('tasks sit on the day they are due; overdue unfinished ones lead today', () => {
  const now = Date.parse('2026-11-11T09:00:00Z')
  const tasks = [
    tk('b-today', '2026-11-11'),
    tk('a-today-done', '2026-11-11', { done: true }),
    tk('a-today', '2026-11-11'),
    tk('late-2', '2026-11-10'),
    tk('late-1', '2026-11-03'),
    tk('late-done', '2026-11-09', { done: true }),
    tk('tomorrow', '2026-11-12'),
    tk('beyond', '2026-11-20')
  ]
  const agenda = buildAgenda([], { now, days: 3, timeZone: 'UTC', tasks })
  assert.deepEqual(
    agenda.days[0].tasks.map((t) => [t.task.id, t.overdue]),
    [['late-1', true], ['late-2', true], ['a-today', false], ['b-today', false], ['a-today-done', false]]
  )
  assert.deepEqual(agenda.days[1].tasks.map((t) => t.task.id), ['tomorrow'])
  assert.deepEqual(agenda.days[2].tasks, [])
})

test('a task due date is a calendar date in every time zone', () => {
  // 23:30 on the 11th in Los Angeles is already the 12th in UTC; the task due the 11th is today.
  const now = Date.parse('2026-11-12T07:30:00Z')
  const agenda = buildAgenda([], { now, days: 1, timeZone: 'America/Los_Angeles', tasks: [tk('report', '2026-11-11')] })
  assert.equal(agenda.days[0].date, '2026-11-11')
  assert.deepEqual(agenda.days[0].tasks.map((t) => [t.task.id, t.overdue]), [['report', false]])
})

test('no tasks given: every day has an empty task list', () => {
  const agenda = buildAgenda([], { now: Date.parse('2026-11-11T09:00:00Z'), days: 2, timeZone: 'UTC' })
  assert.deepEqual(agenda.days.map((d) => d.tasks), [[], []])
})
