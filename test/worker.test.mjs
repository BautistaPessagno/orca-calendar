import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import activate, { deactivate } from '../worker.mjs'
import { createSampleBackend } from '../backends/sample.mjs'
import { fakeSecrets, fakeSettings, fakeStorage } from './fakes.mjs'
import { CalendarError } from '../src/errors.mjs'

const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'))

function fakeOrca(settings = {}) {
  const handlers = new Map()
  const calls = []
  const posts = []
  const orca = {
    panels: { handle: (name, fn) => (handlers.set(name, fn), { dispose() {} }), post: (event, payload) => posts.push({ event, payload }) },
    settings: fakeSettings({ backend: 'sample', ...settings }),
    storage: fakeStorage(),
    secrets: fakeSecrets(),
    host: { call: async (method, params) => (calls.push({ method, params }), method === 'secrets.protection' ? { status: 'os-keyring' } : { ok: true }) },
    log: () => {}
  }
  return { orca, handlers, calls, posts }
}

const settle = () => new Promise((r) => setTimeout(r, 20))

test('manifest: no reserved id, no publisher, the capabilities the spec lists', () => {
  assert.equal(manifest.publisher, undefined)
  assert.ok(!manifest.id.startsWith('orca-'))
  assert.deepEqual(manifest.capabilities.map((c) => c.kind).sort(), ['notifications:show', 'secrets:own', 'settings:own', 'storage:own'])
  assert.deepEqual(manifest.contributes.statusBarItems.map((i) => i.id), ['next-meeting'])
  assert.match(manifest.description, /Not affiliated/)
  const settings = Object.fromEntries(manifest.contributes.settings.map((s) => [s.key, s]))
  assert.deepEqual(settings.backend.enum, ['auto', 'google', 'eventkit', 'sample'])
  assert.equal(settings.notifyMinutes.default, 5)
  assert.equal(settings.redirectPort.default, 43119)
})

test('answers the panel with the sample week and updates the status bar', async () => {
  const { orca, handlers, calls, posts } = fakeOrca()
  const now = () => Date.parse('2026-11-11T10:07:00Z')
  activate(orca, { now, backends: { sample: createSampleBackend({ now }), google: null, eventkit: null }, platform: 'darwin' })
  const snap = await handlers.get('agenda.get')()
  await settle()
  deactivate()
  assert.equal(snap.backend, 'sample')
  assert.equal(snap.status, 'ready')
  assert.ok(snap.events.length > 5)
  const bar = calls.filter((c) => c.method === 'statusBar.update').at(-1).params
  assert.equal(bar.id, 'next-meeting')
  assert.equal(bar.visible, true)
  assert.match(bar.text, /now|in \d+ min/)
  assert.equal(posts[0].event, 'agenda.changed')
  assert.deepEqual(
    [...handlers.keys()].sort(),
    ['agenda.get', 'auth.disconnect', 'auth.info', 'auth.start', 'auth.status', 'backend.select', 'calendars.set', 'event.respond', 'eventkit.request', 'prefs.set', 'task.complete', 'tasks.lists.set']
  )
})

test('prefs.set only takes the panel’s own preferences', async () => {
  const { orca, handlers } = fakeOrca()
  activate(orca, { backends: { sample: createSampleBackend(), google: null, eventkit: null } })
  await handlers.get('prefs.set')({ key: 'days', value: 40 })
  assert.equal(orca.settings.values.days, 14)
  await assert.rejects(handlers.get('prefs.set')({ key: 'backend', value: 'google' }), (e) => e.code === 'invalid')
  deactivate()
})

test('handler errors reach the panel with a code and a sentence', async () => {
  const { orca, handlers } = fakeOrca()
  activate(orca, { backends: { sample: createSampleBackend(), google: null, eventkit: null } })
  await assert.rejects(handlers.get('auth.start')({ clientId: 'nope', clientSecret: 'x' }), (e) => e.code === 'invalid' && /client ID/.test(e.message))
  deactivate()
})

test('event.respond answers an invitation of the sample week, and checks its input', async () => {
  const { orca, handlers } = fakeOrca()
  const now = () => Date.parse('2026-11-11T10:07:00Z')
  activate(orca, { now, backends: { sample: createSampleBackend({ now }), google: null, eventkit: null } })
  const before = await handlers.get('agenda.get')()
  assert.equal(before.capabilities.rsvp, true)
  const invite = before.events.find((e) => e.self?.response === 'needsAction')
  const after = await handlers.get('event.respond')({ id: invite.id, calendarId: invite.calendarId, response: 'tentative' })
  assert.equal(after.events.find((e) => e.id === invite.id).self.response, 'tentative')
  await assert.rejects(handlers.get('event.respond')({ id: invite.id, calendarId: invite.calendarId, response: 'maybe' }), (e) => e.code === 'invalid')
  deactivate()
})

test('the rsvp setting decides the scope the Google login asks for', async () => {
  const { orca, handlers } = fakeOrca({ rsvp: false })
  const started = []
  const auth = { connection: async () => ({ connected: false }), start: async (input) => (started.push(input), { url: 'https://accounts.google.com/x' }), status: async () => ({ status: 'idle' }), close() {} }
  activate(orca, { auth, backends: { sample: createSampleBackend(), google: null, eventkit: null } })
  await handlers.get('auth.start')({ clientId: 'id', clientSecret: 's' })
  assert.equal(started[0].rsvp, false)
  assert.equal((await handlers.get('auth.info')()).rsvp, false)
  deactivate()
})

test('a setup state is not re-read every minute: nothing changes until the person acts', async () => {
  const { orca } = fakeOrca({ backend: 'google' })
  const timers = []
  const google = { id: 'google', capabilities: {}, calendars: async () => { throw new CalendarError('needs-setup', 'Connect your Google account.') }, events: async () => [] }
  activate(orca, { setTimer: (fn, ms) => (timers.push(ms), timers.length), clearTimer: () => {}, backends: { google, sample: createSampleBackend(), eventkit: null } })
  await settle()
  deactivate()
  const refresh = timers.filter((ms) => ms !== undefined && ms >= 60_000)
  assert.ok(refresh.length > 0)
  assert.ok(refresh.every((ms) => ms >= 15 * 60_000), `refresh after ${refresh}`)
})

test('the sample week has tasks, and the panel can tick one off and hide a list', async () => {
  const { orca, handlers } = fakeOrca()
  activate(orca, { backends: { sample: createSampleBackend(), google: null, eventkit: null } })
  let snap = await handlers.get('agenda.get')()
  assert.equal(snap.tasksStatus, 'ready')
  assert.equal(snap.capabilities.completeTasks, true)
  assert.ok(snap.tasks.some((t) => !t.done), 'an unfinished task to tick')
  assert.ok(snap.taskLists.length >= 2)
  const open = snap.tasks.find((t) => t.id === 'review-pr')
  snap = await handlers.get('task.complete')({ id: open.id, listId: open.listId, done: true })
  assert.equal(snap.tasks.find((t) => t.id === open.id).done, true)
  // A done task from an earlier day belongs to that day, which the agenda doesn't show.
  snap = await handlers.get('task.complete')({ id: 'q4-report', listId: 'my-tasks', done: true })
  assert.equal(snap.tasks.find((t) => t.id === 'q4-report'), undefined)
  await assert.rejects(handlers.get('task.complete')({ id: open.id, listId: open.listId, done: 'yes' }), /done/)
  const hidden = snap.taskLists[1].id
  snap = await handlers.get('tasks.lists.set')({ id: hidden, shown: false })
  assert.equal(snap.taskLists.find((l) => l.id === hidden).shown, false)
  assert.ok(!snap.tasks.some((t) => t.listId === hidden))
  deactivate()
})

test('the completeTasks setting decides the Tasks scope the login asks for', async () => {
  const { orca, handlers } = fakeOrca({ completeTasks: false })
  const started = []
  const auth = { connection: async () => ({ connected: false, tasks: 'none' }), start: async (input) => (started.push(input), { url: 'https://accounts.google.com/x' }), status: async () => ({ status: 'idle' }), close() {} }
  activate(orca, { auth, backends: { sample: createSampleBackend(), google: null, eventkit: null } })
  await handlers.get('auth.start')({ clientId: 'id', clientSecret: 's' })
  assert.equal(started[0].completeTasks, false)
  const info = await handlers.get('auth.info')()
  assert.equal(info.completeTasks, false)
  assert.equal(info.tasks, 'none')
  deactivate()
})

test('manifest: the completeTasks setting, on by default', () => {
  const setting = manifest.contributes.settings.find((s) => s.key === 'completeTasks')
  assert.equal(setting?.type, 'boolean')
  assert.equal(setting.default, true)
})
