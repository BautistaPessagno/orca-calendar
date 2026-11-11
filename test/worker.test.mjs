import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import activate, { deactivate } from '../worker.mjs'
import { createSampleBackend } from '../backends/sample.mjs'
import { fakeSecrets, fakeSettings, fakeStorage } from './fakes.mjs'

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
    ['agenda.get', 'auth.disconnect', 'auth.info', 'auth.start', 'auth.status', 'backend.select', 'calendars.set', 'eventkit.request', 'prefs.set']
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
