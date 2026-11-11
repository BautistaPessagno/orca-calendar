// The real panel in headless Chrome: the Connect screen, redraws while typing, and the way from
// the sample week to Google. Skipped where Chrome isn't installed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSampleBackend } from '../backends/sample.mjs'
import { MESSAGES } from '../src/errors.mjs'
import { hasChrome, runPanel } from './helpers/panel-page.mjs'

const skip = hasChrome ? false : 'needs Google Chrome'

const google = (status, message) => ({ backend: 'google', status, message, events: [], calendars: [], days: 3, capabilities: {} })
const neverConnected = google('needs-setup', MESSAGES.needsSetup)
const ended = google('unauthenticated', MESSAGES.unauthenticated)
const authInfo = (extra = {}) => ({ clientId: null, hasSecret: false, connected: false, platform: 'darwin', redirectUri: 'http://127.0.0.1:43119/callback', missingScopes: [], rsvp: true, ...extra })

test('Continue sends the client ID and the secret the person typed', { skip }, async () => {
  const out = await runPanel({
    responses: { 'agenda.get': neverConnected, 'auth.info': authInfo(), 'auth.start': { url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' } },
    script: `
      type('cid', '1234567890-abcdefghijklmnop.apps.googleusercontent.com')
      type('csecret', 'GOCSPX-madeUpSecret')
      press('#continue')
      await wait(300)
      done({ start: calls.filter((c) => c.name === 'auth.start').map((c) => c.input), signIn: Boolean(document.getElementById('signin')) })`
  })
  assert.deepEqual(out.start, [{ clientId: '1234567890-abcdefghijklmnop.apps.googleusercontent.com', clientSecret: 'GOCSPX-madeUpSecret' }])
  assert.equal(out.signIn, true)
})

test('a redraw while the person types keeps the text, the focus and the caret', { skip }, async () => {
  const out = await runPanel({
    responses: { 'agenda.get': neverConnected, 'auth.info': authInfo() },
    script: `
      type('cid', 'typed-client-id')
      type('csecret', 'GOCSPX-half')
      document.getElementById('csecret').setSelectionRange(3, 3)
      post('agenda.changed') // the worker read the calendar again
      await wait(300)
      theme() // Orca's theme changed
      await wait(100)
      const field = document.getElementById('csecret')
      done({
        cid: document.getElementById('cid').value,
        secret: field.value,
        focused: document.activeElement && document.activeElement.id,
        caret: field.selectionStart,
        redrawn: calls.filter((c) => c.name === 'agenda.get').length
      })`
  })
  assert.ok(out.redrawn >= 2, 'the post made the panel read and draw again')
  assert.equal(out.cid, 'typed-client-id')
  assert.equal(out.secret, 'GOCSPX-half')
  assert.equal(out.focused, 'csecret')
  assert.equal(out.caret, 3)
})

test('the setup help the person opened stays open across a redraw', { skip }, async () => {
  const out = await runPanel({
    responses: { 'agenda.get': neverConnected, 'auth.info': authInfo({ clientId: '1234567890-abcdefghijklmnop.apps.googleusercontent.com', hasSecret: true }) },
    script: `
      await wait(200)
      const closedAtFirst = !document.getElementById('help').open
      document.getElementById('help').open = true
      post('agenda.changed')
      await wait(300)
      done({ closedAtFirst, openAfter: document.getElementById('help').open })`
  })
  assert.equal(out.closedAtFirst, true)
  assert.equal(out.openAfter, true)
})

test('a first-time Google user is welcomed; only an ended login says "again"', { skip }, async () => {
  const heading = `await wait(200); done({ h: document.querySelector('.hero h2').textContent, p: document.querySelector('.hero p').textContent })`
  const first = await runPanel({ responses: { 'agenda.get': neverConnected, 'auth.info': authInfo() }, script: heading })
  assert.equal(first.h, 'Connect Google Calendar')
  assert.doesNotMatch(first.p, /ended/)
  const again = await runPanel({ responses: { 'agenda.get': ended, 'auth.info': authInfo({ clientId: 'x.apps.googleusercontent.com', hasSecret: true }) }, script: heading })
  assert.equal(again.h, 'Connect Google Calendar again')
  assert.match(again.p, /ended/)
})

test('the sample week shows the way to Google, and it leads to the Connect screen', { skip }, async () => {
  const now = Date.now()
  const sample = { backend: 'sample', status: 'ready', days: 3, showDeclined: false, capabilities: { rsvp: true }, fetchedAt: now, calendars: (await createSampleBackend().calendars()).map((c) => ({ ...c, shown: c.selected })), events: [] }
  const out = await runPanel({
    responses: { 'agenda.get': sample, 'auth.info': authInfo(), 'backend.select': neverConnected },
    script: `
      await wait(200)
      const card = document.querySelector('.promo')
      const cardText = card ? card.textContent : null
      const footerLink = Boolean(document.querySelector('.foot [data-backend="google"]'))
      press('.promo [data-backend="google"]')
      await wait(300)
      done({ cardText, footerLink, selected: calls.filter((c) => c.name === 'backend.select').map((c) => c.input), heading: document.querySelector('.hero h2') && document.querySelector('.hero h2').textContent })`
  })
  assert.match(out.cardText, /sample week/)
  assert.match(out.cardText, /Connect Google Calendar/)
  assert.equal(out.footerLink, true)
  assert.deepEqual(out.selected, [{ backend: 'google' }])
  assert.equal(out.heading, 'Connect Google Calendar')
})

// ---------- Google Tasks ----------

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const yesterday = () => {
  const d = new Date(Date.now() - 86_400_000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const gTask = (id, due, extra = {}) => ({ id, listId: 'l1', listTitle: 'My Tasks', title: id, notes: null, due, done: false, completedAt: null, parentId: null, assigned: false, link: null, ...extra })
const googleReady = (extra = {}) => ({
  backend: 'google', status: 'ready', days: 3, showDeclined: false, fetchedAt: Date.now(),
  calendars: [{ id: 'me', title: 'Me', color: '#039be5', account: 'Google', shown: true }], events: [],
  tasks: [], taskLists: [], tasksStatus: 'ready', capabilities: { rsvp: true, completeTasks: true }, ...extra
})

test('tasks show under their day, overdue on today, and the checkbox ticks one off', { skip }, async () => {
  const snap = googleReady({ tasks: [gTask('Send the report', yesterday()), gTask('Review PR', today())], taskLists: [{ id: 'l1', title: 'My Tasks', shown: true }] })
  const ticked = { ...snap, tasks: [snap.tasks[0], { ...snap.tasks[1], done: true }] }
  const out = await runPanel({
    responses: { 'agenda.get': snap, 'auth.info': authInfo({ connected: true, tasks: 'write' }), 'task.complete': ticked },
    script: `
      await wait(200)
      const rows = [...document.querySelector('.day.today').querySelectorAll('.task')].map((r) => [r.querySelector('.title').textContent, Boolean(r.querySelector('.overdue'))])
      press('.task [data-task="Review PR"]')
      await wait(300)
      const ticked = document.querySelectorAll('.task.done .title')
      done({ rows, sent: calls.filter((c) => c.name === 'task.complete').map((c) => c.input), done: [...ticked].map((d) => d.textContent) })`
  })
  assert.deepEqual(out.rows, [['Send the report', true], ['Review PR', false]])
  assert.deepEqual(out.sent, [{ id: 'Review PR', listId: 'l1', done: true }])
  assert.deepEqual(out.done, ['Review PR'])
})

test('a refused tick goes back and says why', { skip }, async () => {
  const snap = googleReady({ tasks: [gTask('Review PR', today())] })
  const out = await runPanel({
    responses: { 'agenda.get': snap, 'auth.info': authInfo({ connected: true, tasks: 'write' }), 'task.complete': { __throw: 'Google Tasks answered: Backend Error' } },
    script: `
      await wait(200)
      press('.task [data-task="Review PR"]')
      await wait(300)
      done({ done: document.querySelectorAll('.task.done').length, alert: document.querySelector('[role=alert]') && document.querySelector('[role=alert]').textContent })`
  })
  assert.equal(out.done, 0)
  assert.match(out.alert, /Backend Error/)
})

test('without a Tasks permission the agenda shows nothing new; the picker offers to add it', { skip }, async () => {
  const snap = googleReady({ tasksStatus: 'no-scope', capabilities: { rsvp: true, completeTasks: false } })
  const out = await runPanel({
    responses: { 'agenda.get': snap, 'auth.info': authInfo({ connected: true, tasks: 'none' }), 'auth.start': { url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' } },
    script: `
      await wait(200)
      const agenda = { tasks: document.querySelectorAll('.task').length, banners: document.querySelectorAll('.banner').length, text: document.querySelector('.agenda').textContent }
      press('#settings')
      await wait(100)
      const offer = document.getElementById('reauth') && document.getElementById('reauth').textContent
      press('#reauth')
      await wait(200)
      done({ agenda, offer, started: calls.filter((c) => c.name === 'auth.start').length, signIn: Boolean(document.getElementById('signin')) })`
  })
  assert.equal(out.agenda.tasks, 0)
  assert.equal(out.agenda.banners, 0)
  assert.doesNotMatch(out.agenda.text, /task/i)
  assert.match(out.offer, /Show Google Tasks/)
  assert.equal(out.started, 1)
  assert.equal(out.signIn, true)
})

test('a read-only Tasks login shows tasks without a checkbox', { skip }, async () => {
  const snap = googleReady({ tasks: [gTask('Review PR', today())], capabilities: { rsvp: true, completeTasks: false } })
  const out = await runPanel({
    responses: { 'agenda.get': snap, 'auth.info': authInfo({ connected: true, tasks: 'read' }) },
    script: `await wait(200); done({ rows: document.querySelectorAll('.task').length, buttons: document.querySelectorAll('button.tick').length })`
  })
  assert.equal(out.rows, 1)
  assert.equal(out.buttons, 0)
})
