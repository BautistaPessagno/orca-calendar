import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ITEM_ID, createTicker, nextChange, statusBarView } from '../src/status-bar.mjs'
import { createReminders } from '../src/reminders.mjs'

const at = (iso) => Date.parse(iso)
const ev = (id, start, end, extra = {}) => ({ id, calendarId: 'work', title: id, allDay: false, start: at(start), end: at(end), status: 'confirmed', busy: true, attendees: [], self: null, ...extra })
const fmt = { locale: 'en-GB', timeZone: 'UTC' }

const standup = ev('Standup', '2026-11-11T09:30:00Z', '2026-11-11T09:45:00Z', { conference: { kind: 'meet', url: 'https://meet.google.com/abc-defg-hij', label: 'Google Meet' } })
const review = ev('Design review', '2026-11-11T09:45:00Z', '2026-11-11T10:30:00Z', { location: 'Room 4' })

test('hidden while nothing starts within the hour', () => {
  assert.equal(statusBarView([standup], at('2026-11-11T08:00:00Z'), fmt), null)
  assert.equal(statusBarView([], at('2026-11-11T08:00:00Z'), fmt), null)
})

test('counts down in minutes, then hours and minutes', () => {
  assert.deepEqual(statusBarView([standup], at('2026-11-11T09:18:00Z'), fmt), {
    text: 'Standup in 12 min',
    icon: 'calendar',
    tone: 'neutral',
    tooltip: 'Standup · 09:30–09:45 · Google Meet'
  })
  assert.equal(statusBarView([standup], at('2026-11-11T09:17:30Z'), fmt).text, 'Standup in 13 min')
  assert.equal(statusBarView([standup], at('2026-11-11T08:31:00Z'), { ...fmt, leadMs: 2 * 3600_000 }).text, 'Standup in 59 min')
  assert.equal(statusBarView([standup], at('2026-11-11T08:00:00Z'), { ...fmt, leadMs: 2 * 3600_000 }).text, 'Standup in 1 h 30 min')
})

test('warning tone inside five minutes, "now" while it runs', () => {
  const soon = statusBarView([standup], at('2026-11-11T09:26:00Z'), fmt)
  assert.equal(soon.text, 'Standup in 4 min')
  assert.equal(soon.tone, 'warning')
  assert.equal(statusBarView([standup], at('2026-11-11T09:29:30Z'), fmt).text, 'Standup in 1 min')
  const now = statusBarView([standup], at('2026-11-11T09:30:00Z'), fmt)
  assert.equal(now.text, 'Standup now')
  assert.equal(now.tone, 'accent')
  assert.equal(now.tooltip, 'Standup · 09:30–09:45 · Google Meet · ends in 15 min')
})

test('back to back: the next meeting takes over five minutes before it starts', () => {
  const long = ev('Planning', '2026-11-11T09:00:00Z', '2026-11-11T10:00:00Z')
  const next = ev('1:1', '2026-11-11T10:00:00Z', '2026-11-11T10:30:00Z')
  assert.equal(statusBarView([long, next], at('2026-11-11T09:50:00Z'), fmt).text, 'Planning now')
  assert.equal(statusBarView([long, next], at('2026-11-11T09:56:00Z'), fmt).text, '1:1 in 4 min')
})

test('long titles are clipped', () => {
  const view = statusBarView([{ ...standup, title: 'x'.repeat(80) }], at('2026-11-11T09:20:00Z'), fmt)
  assert.ok(view.text.length <= 48)
  assert.ok(view.text.includes('…'))
})

test('nextChange: the next whole minute while counting, else the next boundary', () => {
  // Counting: 12 min left at 09:18:00 → the text changes at 09:19:00 (11 min).
  assert.equal(nextChange([standup], at('2026-11-11T09:18:00Z')), at('2026-11-11T09:19:00Z'))
  assert.equal(nextChange([standup], at('2026-11-11T09:17:30Z')), at('2026-11-11T09:18:00Z'))
  // Nothing near: wake when it comes within the hour.
  assert.equal(nextChange([standup], at('2026-11-11T07:00:00Z')), at('2026-11-11T08:30:00Z'))
  // Running: at its end, or when the next one comes within five minutes.
  assert.equal(nextChange([standup, review], at('2026-11-11T09:31:00Z')), at('2026-11-11T09:40:00Z'))
  assert.equal(nextChange([], at('2026-11-11T07:00:00Z')), null)
})

test('the ticker updates the item at each change and only sends changes', async () => {
  const calls = []
  const timers = []
  let clock = at('2026-11-11T09:18:00Z')
  const ticker = createTicker({
    host: { call: async (method, params) => (calls.push(params), { ok: true }) },
    now: () => clock,
    setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimer: () => {},
    format: () => fmt
  })
  await ticker.update([standup])
  assert.equal(calls.at(-1).id, ITEM_ID)
  assert.equal(calls.at(-1).text, 'Standup in 12 min')
  assert.equal(timers.at(-1).ms, 60_000)
  await ticker.update([standup])
  assert.equal(calls.length, 1)
  clock = at('2026-11-11T09:46:00Z')
  await timers.at(-1).fn()
  assert.deepEqual(calls.at(-1), { id: ITEM_ID, visible: false })
  ticker.stop()
})

test('reminders: once per meeting, a set number of minutes before, kept across restarts', async () => {
  const shown = []
  const store = {}
  const storage = { get: async (k) => store[k] ?? null, set: async (k, v) => void (store[k] = v) }
  const host = { call: async (method, params) => (shown.push({ method, ...params }), { delivered: true }) }
  const make = () => createReminders({ host, storage, format: () => fmt })
  let reminders = make()
  const settings = { notify: true, notifyMinutes: 5 }
  await reminders.check([standup, review], at('2026-11-11T09:20:00Z'), settings)
  assert.equal(shown.length, 0)
  await reminders.check([standup, review], at('2026-11-11T09:25:00Z'), settings)
  assert.deepEqual(shown, [{ method: 'notifications.show', title: 'Standup in 5 min', body: '09:30–09:45 · Google Meet' }])
  await reminders.check([standup, review], at('2026-11-11T09:26:00Z'), settings)
  assert.equal(shown.length, 1)
  reminders = make() // the worker restarted
  await reminders.check([standup, review], at('2026-11-11T09:27:00Z'), settings)
  assert.equal(shown.length, 1)
  assert.equal(reminders.nextAt([standup, review], at('2026-11-11T09:27:00Z'), settings), at('2026-11-11T09:40:00Z'))
  await reminders.check([standup, review], at('2026-11-11T09:41:00Z'), settings)
  assert.equal(shown.at(-1).title, 'Design review in 4 min')
  assert.equal(shown.at(-1).body, '09:45–10:30 · Room 4')
})

test('reminders: off, at the start, and never for a meeting already over', async () => {
  const shown = []
  const host = { call: async (method, params) => (shown.push(params), { delivered: true }) }
  const storage = { get: async () => null, set: async () => {} }
  const reminders = createReminders({ host, storage, format: () => fmt })
  await reminders.check([standup], at('2026-11-11T09:29:00Z'), { notify: false, notifyMinutes: 5 })
  assert.equal(shown.length, 0)
  assert.equal(reminders.nextAt([standup], at('2026-11-11T09:00:00Z'), { notify: false, notifyMinutes: 5 }), null)
  await reminders.check([standup], at('2026-11-11T09:30:00Z'), { notify: true, notifyMinutes: 0 })
  assert.equal(shown.at(-1).title, 'Standup starts now')
  await reminders.check([review], at('2026-11-11T10:31:00Z'), { notify: true, notifyMinutes: 5 })
  assert.equal(shown.length, 1)
})
