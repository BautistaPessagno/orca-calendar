import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { ENDED_KEY, SECRET_KEY, TOKENS_KEY, createAuth, scopesFor } from '../backends/google/auth.mjs'
import { TOKEN, fakeGoogle, fakeSecrets, fakeSettings, reply } from './fakes.mjs'

const CLIENT_ID = '1234567890-abcdefghijklmnop.apps.googleusercontent.com'
const SECRET = 'GOCSPX-madeUpSecretForTests'

// A loopback server stand-in: records the handler so the test can play the browser's redirect.
function fakeListen() {
  const servers = []
  const listen = async (port, handle) => {
    const server = { port: port || 50123, handle, closed: false, close() { this.closed = true } }
    servers.push(server)
    return server
  }
  return { listen, servers }
}

const base64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

test('asks for read-only scopes unless answering invitations is on', () => {
  assert.deepEqual(scopesFor({ rsvp: false }), [
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.events.readonly'
  ])
  assert.deepEqual(scopesFor({ rsvp: true }), [
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.events'
  ])
})

test('a full login: PKCE authorize URL, loopback redirect, code exchange with the secret', async () => {
  const settings = fakeSettings({})
  const secrets = fakeSecrets()
  const google = fakeGoogle({
    [`POST ${TOKEN}`]: reply(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3599, scope: scopesFor({ rsvp: false }).join(' '), token_type: 'Bearer' })
  })
  const { listen, servers } = fakeListen()
  let clock = 1_000_000
  const auth = createAuth({ settings, secrets, fetchImpl: google.fetchImpl, listen, now: () => clock })

  const { url } = await auth.start({ clientId: ` ${CLIENT_ID} `, clientSecret: SECRET })
  assert.equal(settings.values.clientId, CLIENT_ID)
  assert.equal(secrets.values[SECRET_KEY], SECRET)
  const authorize = new URL(url)
  assert.equal(authorize.origin + authorize.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  const q = Object.fromEntries(authorize.searchParams)
  assert.equal(q.client_id, CLIENT_ID)
  assert.equal(q.response_type, 'code')
  assert.equal(q.redirect_uri, 'http://127.0.0.1:43119/callback')
  assert.equal(q.code_challenge_method, 'S256')
  assert.equal(q.access_type, 'offline')
  assert.equal(q.prompt, 'consent')
  assert.ok(q.scope.includes('calendar.events.readonly'))
  assert.deepEqual(await auth.status(), { status: 'pending' })

  const wrong = await servers[0].handle(new URLSearchParams({ state: 'nope', code: 'c' }))
  assert.equal(wrong.status, 400)

  const page = await servers[0].handle(new URLSearchParams({ state: q.state, code: 'the-code' }))
  assert.equal(page.status, 200)
  const exchange = google.requests[0].body
  assert.equal(exchange.grant_type, 'authorization_code')
  assert.equal(exchange.code, 'the-code')
  assert.equal(exchange.client_secret, SECRET)
  assert.equal(exchange.redirect_uri, 'http://127.0.0.1:43119/callback')
  assert.equal(q.code_challenge, base64url(createHash('sha256').update(exchange.code_verifier).digest()))
  assert.deepEqual(await auth.status(), { status: 'connected' })
  assert.equal(await auth.getAccessToken(), 'at-1')
  assert.equal(JSON.parse(secrets.values[TOKENS_KEY]).refresh_token, 'rt-1')

  // An hour later the token is refreshed, keeping the refresh token Google didn't resend.
  google.routes[`POST ${TOKEN}`] = reply(200, { access_token: 'at-2', expires_in: 3599 })
  clock += 3600_000
  assert.equal(await auth.getAccessToken(), 'at-2')
  assert.equal(google.requests[1].body.grant_type, 'refresh_token')
  assert.equal(google.requests[1].body.client_secret, SECRET)
  assert.equal(JSON.parse(secrets.values[TOKENS_KEY]).refresh_token, 'rt-1')
})

test('refuses a client ID that is not a Google OAuth client ID', async () => {
  const auth = createAuth({ settings: fakeSettings(), secrets: fakeSecrets(), listen: fakeListen().listen })
  await assert.rejects(auth.start({ clientId: 'hello', clientSecret: SECRET }), /client ID/)
  await assert.rejects(auth.start({ clientId: CLIENT_ID, clientSecret: '' }), /client secret/)
})

test('never connected is "needs setup", with or without a client ID', async () => {
  const auth = createAuth({ settings: fakeSettings(), secrets: fakeSecrets(), listen: fakeListen().listen })
  await assert.rejects(auth.getAccessToken(), (e) => e.kind === 'needs-setup')
  // A client ID saved, but the login never finished: still a first-time setup, not an ended login.
  const auth2 = createAuth({ settings: fakeSettings({ clientId: CLIENT_ID }), secrets: fakeSecrets({ [SECRET_KEY]: SECRET }), listen: fakeListen().listen })
  await assert.rejects(auth2.getAccessToken(), (e) => e.kind === 'needs-setup' && !/ended/.test(e.message))
})

test('a login Google ended stays "ended" across restarts, until the next login', async () => {
  const tokens = { access_token: 'old', refresh_token: 'rt', expires_at: 0, client_id: CLIENT_ID, scopes: '' }
  const secrets = fakeSecrets({ [SECRET_KEY]: SECRET, [TOKENS_KEY]: JSON.stringify(tokens) })
  const settings = fakeSettings({ clientId: CLIENT_ID })
  const google = fakeGoogle({ [`POST ${TOKEN}`]: [reply(400, { error: 'invalid_grant' }), reply(200, { access_token: 'new', refresh_token: 'rt2', expires_in: 3599 })] })
  const { listen, servers } = fakeListen()
  await assert.rejects(createAuth({ settings, secrets, fetchImpl: google.fetchImpl, listen }).getAccessToken(), (e) => e.kind === 'unauthenticated')
  const restarted = createAuth({ settings, secrets, fetchImpl: google.fetchImpl, listen })
  await assert.rejects(restarted.getAccessToken(), (e) => e.kind === 'unauthenticated' && /ended/.test(e.message))
  const { url } = await restarted.start()
  await servers[0].handle(new URLSearchParams({ state: new URL(url).searchParams.get('state'), code: 'c' }))
  assert.equal(await restarted.getAccessToken(), 'new')
  assert.equal(secrets.values[ENDED_KEY], undefined)
})

test('an API refusal of a fresh token (expire) also counts as an ended login', async () => {
  const tokens = { access_token: 'at', refresh_token: 'rt', expires_at: Date.now() + 3600_000, client_id: CLIENT_ID, scopes: '' }
  const secrets = fakeSecrets({ [SECRET_KEY]: SECRET, [TOKENS_KEY]: JSON.stringify(tokens) })
  const auth = createAuth({ settings: fakeSettings({ clientId: CLIENT_ID }), secrets, listen: fakeListen().listen })
  await auth.expire()
  await assert.rejects(auth.getAccessToken(), (e) => e.kind === 'unauthenticated')
})

test('disconnecting is the person’s choice: back to "needs setup", not "ended"', async () => {
  const tokens = { access_token: 'at', refresh_token: 'rt', expires_at: Date.now() + 3600_000, client_id: CLIENT_ID, scopes: '' }
  const secrets = fakeSecrets({ [SECRET_KEY]: SECRET, [TOKENS_KEY]: JSON.stringify(tokens), [ENDED_KEY]: '2026-11-01T00:00:00.000Z' })
  const google = fakeGoogle({ 'POST oauth2.googleapis.com/revoke': reply(200, {}) })
  const auth = createAuth({ settings: fakeSettings({ clientId: CLIENT_ID }), secrets, fetchImpl: google.fetchImpl, listen: fakeListen().listen })
  await auth.disconnect()
  await assert.rejects(auth.getAccessToken(), (e) => e.kind === 'needs-setup')
})

test('a revoked login (invalid_grant) is forgotten', async () => {
  const tokens = { access_token: 'old', refresh_token: 'rt', expires_at: 0, client_id: CLIENT_ID, scopes: '' }
  const secrets = fakeSecrets({ [SECRET_KEY]: SECRET, [TOKENS_KEY]: JSON.stringify(tokens) })
  const google = fakeGoogle({ [`POST ${TOKEN}`]: reply(400, { error: 'invalid_grant' }) })
  const auth = createAuth({ settings: fakeSettings({ clientId: CLIENT_ID }), secrets, fetchImpl: google.fetchImpl, listen: fakeListen().listen })
  await assert.rejects(auth.getAccessToken(), (e) => e.kind === 'unauthenticated')
  assert.equal(secrets.values[TOKENS_KEY], undefined)
})

test('the person declining in the browser ends the login with a sentence', async () => {
  const { listen, servers } = fakeListen()
  const auth = createAuth({ settings: fakeSettings(), secrets: fakeSecrets(), listen })
  const { url } = await auth.start({ clientId: CLIENT_ID, clientSecret: SECRET })
  const state = new URL(url).searchParams.get('state')
  await servers[0].handle(new URLSearchParams({ state, error: 'access_denied' }))
  assert.deepEqual(await auth.status(), { status: 'failed', message: 'You declined the Google login.' })
})

test('an admin block (admin_policy_enforced) says who can fix it', async () => {
  const { listen, servers } = fakeListen()
  const auth = createAuth({ settings: fakeSettings(), secrets: fakeSecrets(), listen })
  const { url } = await auth.start({ clientId: CLIENT_ID, clientSecret: SECRET })
  const state = new URL(url).searchParams.get('state')
  await servers[0].handle(new URLSearchParams({ state, error: 'admin_policy_enforced' }))
  const status = await auth.status()
  assert.equal(status.status, 'failed')
  assert.match(status.message, /admin/)
})

test('connection reports what the panel shows, and disconnect revokes and forgets', async () => {
  const tokens = { access_token: 'at', refresh_token: 'rt', expires_at: Date.now() + 3600_000, client_id: CLIENT_ID, scopes: scopesFor({ rsvp: false }).join(' '), email: null }
  const secrets = fakeSecrets({ [SECRET_KEY]: SECRET, [TOKENS_KEY]: JSON.stringify(tokens) })
  const google = fakeGoogle({ 'POST oauth2.googleapis.com/revoke': reply(200, {}) })
  const auth = createAuth({ settings: fakeSettings({ clientId: CLIENT_ID }), secrets, fetchImpl: google.fetchImpl, listen: fakeListen().listen })
  const info = await auth.connection({ rsvp: true })
  assert.equal(info.connected, true)
  assert.equal(info.hasSecret, true)
  assert.deepEqual(info.missingScopes, ['https://www.googleapis.com/auth/calendar.events'])
  await auth.disconnect()
  assert.equal(google.requests[0].body.token, 'rt')
  assert.equal(secrets.values[TOKENS_KEY], undefined)
  assert.equal((await auth.connection({ rsvp: false })).connected, false)
})

test('tokens live in memory when the OS has no keyring', async () => {
  const google = fakeGoogle({ [`POST ${TOKEN}`]: reply(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3599 }) })
  const { listen, servers } = fakeListen()
  const secrets = fakeSecrets({}, { failSet: true })
  const auth = createAuth({ settings: fakeSettings(), secrets, fetchImpl: google.fetchImpl, listen })
  const { url } = await auth.start({ clientId: CLIENT_ID, clientSecret: SECRET })
  await servers[0].handle(new URLSearchParams({ state: new URL(url).searchParams.get('state'), code: 'c' }))
  assert.equal(await auth.getAccessToken(), 'at')
  assert.equal((await auth.connection({})).protection, 'unavailable')
})
