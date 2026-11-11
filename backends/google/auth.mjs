// Google login: Authorization Code with PKCE and a loopback redirect, for the person's own OAuth
// client of type "Desktop app" (see docs/research/calendar-backends.md).
//
// start() builds the authorize URL and opens a server on 127.0.0.1 that waits for Google's
// redirect. The panel opens the URL in the browser on a click. Google's token endpoint wants the
// desktop client's secret along with the PKCE verifier; the secret is kept in orca.secrets, the
// client ID in the `clientId` setting, the tokens as one JSON secret. When the OS has no keyring,
// secrets.set fails and the tokens live in worker memory until the worker stops.
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { CalendarError, MESSAGES } from '../../src/errors.mjs'

const SCOPE = 'https://www.googleapis.com/auth/'
export const scopesFor = ({ rsvp } = {}) => [SCOPE + 'calendar.calendarlist.readonly', SCOPE + (rsvp ? 'calendar.events' : 'calendar.events.readonly')]

export const DEFAULT_PORT = 43119
export const TOKENS_KEY = 'google.tokens'
export const SECRET_KEY = 'google.clientSecret'
// Set when Google ended a login (revoked, expired), so the panel can say "connect again" instead
// of greeting a first-time user. Cleared by the next login and by Disconnect.
export const ENDED_KEY = 'google.loginEnded'

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const LOGIN_TIMEOUT_MS = 3 * 60_000
const REFRESH_EARLY_MS = 60_000
const CLIENT_ID = /^[0-9]{6,20}-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$/
const SECRET = /^[A-Za-z0-9_-]{8,128}$/

const base64url = (buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>` +
  `<body style="font:15px system-ui;margin:20vh auto;max-width:28em;text-align:center">` +
  `<h1 style="font-size:20px">${escape(title)}</h1><p>${escape(body)}</p></body>`

const LOGIN_ERRORS = {
  access_denied: 'You declined the Google login.',
  admin_policy_enforced: MESSAGES.blocked,
  org_internal: 'This OAuth client only accepts accounts of the organization that owns its Google Cloud project. Sign in with that account, or make the client External.'
}

export function createAuth({ settings, secrets, protection = async () => 'os-keyring', fetchImpl = globalThis.fetch, now = Date.now, listen = listenLoopback }) {
  let memory = null
  let memoryOnly = false
  let refreshing = null
  let login = null
  let result = { status: 'idle' }

  const clientId = async () => {
    const value = await Promise.resolve(settings.get('clientId')).catch(() => '')
    return typeof value === 'string' ? value.trim() : ''
  }
  let secretMemory = null // the client secret, when the keyring refused it
  const clientSecret = async () => secretMemory ?? (await Promise.resolve(secrets.get(SECRET_KEY)).catch(() => null)) ?? ''

  const port = async () => {
    const value = Number(await Promise.resolve(settings.get('redirectPort')).catch(() => undefined))
    return Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : DEFAULT_PORT
  }

  const load = async () => {
    if (memory || memoryOnly) return memory
    const raw = await Promise.resolve(secrets.get(TOKENS_KEY)).catch(() => null)
    try {
      memory = raw ? JSON.parse(raw) : null
    } catch {
      memory = null
    }
    return memory
  }

  let endedMemory = null // the ENDED_KEY value, when the keyring refused it

  const save = async (tokens) => {
    memory = tokens
    endedMemory = null
    await Promise.resolve(secrets.delete(ENDED_KEY)).catch(() => {})
    try {
      await secrets.set(TOKENS_KEY, JSON.stringify(tokens))
      memoryOnly = false
    } catch {
      memoryOnly = true
    }
  }

  // `ended`: Google ended the login, as opposed to the person disconnecting.
  const forget = async ({ ended = false } = {}) => {
    memory = null
    memoryOnly = false
    await Promise.resolve(secrets.delete(TOKENS_KEY)).catch(() => {})
    if (ended) {
      endedMemory = new Date(now()).toISOString()
      await Promise.resolve(secrets.set(ENDED_KEY, endedMemory)).catch(() => {})
    } else {
      endedMemory = null
      await Promise.resolve(secrets.delete(ENDED_KEY)).catch(() => {})
    }
  }

  const loginEnded = async () => Boolean(endedMemory ?? (await Promise.resolve(secrets.get(ENDED_KEY)).catch(() => null)))

  // No usable login: a first-time setup, or one Google ended.
  const noLogin = async () =>
    (await loginEnded()) ? new CalendarError('unauthenticated', MESSAGES.unauthenticated) : new CalendarError('needs-setup', MESSAGES.needsSetup)

  const post = async (url, form) => {
    let response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(10_000)
      })
    } catch (error) {
      throw new CalendarError('offline', MESSAGES.offline, { cause: error })
    }
    const body = await response.json().catch(() => ({}))
    return { ok: response.ok, status: response.status, body: body ?? {} }
  }

  const tokensFrom = (body, previous, id) => ({
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? previous?.refresh_token,
    expires_at: now() + Number(body.expires_in ?? 3600) * 1000,
    authorized_at: previous?.authorized_at ?? now(),
    scopes: body.scope ?? previous?.scopes ?? '',
    client_id: id
  })

  const refresh = async (tokens, id) => {
    const { ok, body } = await post(TOKEN_URL, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: id, client_secret: await clientSecret() })
    if (ok && body.access_token) {
      const next = tokensFrom(body, tokens, id)
      await save(next)
      return next.access_token
    }
    // Revoked, expired (7 days for an External app in Testing), or another client: log in again.
    if (body.error === 'invalid_grant' || body.error === 'invalid_client' || body.error === 'unauthorized_client') {
      await forget({ ended: true })
      throw new CalendarError('unauthenticated', MESSAGES.unauthenticated)
    }
    throw new CalendarError('error', `Google did not refresh the login: ${body.error_description ?? body.error ?? 'unknown error'}`)
  }

  async function getAccessToken({ force = false } = {}) {
    const id = await clientId()
    if (!id) throw new CalendarError('needs-setup', MESSAGES.needsSetup)
    const tokens = await load()
    // No login yet, or one made with another client ID (the person changed it): set up anew.
    if (!tokens?.access_token || (tokens.client_id && tokens.client_id !== id)) throw await noLogin()
    if (!force && tokens.expires_at - REFRESH_EARLY_MS > now()) return tokens.access_token
    if (!tokens.refresh_token) {
      await forget({ ended: true })
      throw new CalendarError('unauthenticated', MESSAGES.unauthenticated)
    }
    refreshing ??= refresh(tokens, id).finally(() => {
      refreshing = null
    })
    return refreshing
  }

  const closeLogin = ({ keepServer = false } = {}) => {
    if (!login) return
    clearTimeout(login.timer)
    if (!keepServer) login.server.close()
    login = null
  }

  const armTimeout = () => {
    clearTimeout(login.timer)
    login.timer = setTimeout(() => {
      closeLogin()
      result = { status: 'failed', message: 'The login timed out. Press Connect to try again.' }
    }, LOGIN_TIMEOUT_MS)
    login.timer.unref?.()
  }

  const onCallback = async (query, current) => {
    if (query.get('state') !== current.state) return { status: 400, html: page('Login link out of date', 'Start the login again from Orca.') }
    if (login === current) closeLogin({ keepServer: true })
    const error = query.get('error')
    if (error) {
      result = { status: 'failed', message: LOGIN_ERRORS[error] ?? `Google login failed: ${error.slice(0, 80)}` }
      return { status: 200, close: true, html: page('Not connected', `${result.message} You can close this tab.`) }
    }
    const { ok, body } = await post(TOKEN_URL, {
      grant_type: 'authorization_code',
      code: query.get('code') ?? '',
      redirect_uri: current.redirectUri,
      client_id: current.clientId,
      client_secret: current.secret,
      code_verifier: current.verifier
    }).catch((failure) => ({ ok: false, body: { error_description: failure.message } }))
    if (!ok || !body.access_token) {
      result = { status: 'failed', message: `Google login failed: ${body.error_description ?? body.error ?? 'no token'}` }
      return { status: 502, close: true, html: page('Not connected', `${result.message} Go back to Orca and try again.`) }
    }
    await save({ ...tokensFrom(body, null, current.clientId), authorized_at: now() })
    result = { status: 'connected' }
    return { status: 200, close: true, html: page('Connected', 'Go back to Orca. You can close this tab.') }
  }

  return {
    getAccessToken,

    // Saves the client ID and secret when given, builds the authorize URL and waits for the
    // redirect. Calling it again while a login waits returns the same URL.
    async start({ clientId: newId, clientSecret: newSecret, rsvp = false } = {}) {
      if (newId !== undefined) {
        const trimmed = String(newId).trim()
        if (!CLIENT_ID.test(trimmed)) throw new CalendarError('invalid', 'That doesn’t look like a Google OAuth client ID. It ends in .apps.googleusercontent.com.')
        if (trimmed !== (await clientId())) await settings.set('clientId', trimmed)
      }
      if (newSecret !== undefined && String(newSecret).trim()) {
        const trimmed = String(newSecret).trim()
        if (!SECRET.test(trimmed)) throw new CalendarError('invalid', 'That doesn’t look like a Google client secret.')
        try {
          await secrets.set(SECRET_KEY, trimmed)
          secretMemory = null
        } catch {
          secretMemory = trimmed
        }
      }
      const id = await clientId()
      if (!id) throw new CalendarError('needs-setup', MESSAGES.needsSetup)
      const secret = await clientSecret()
      if (!secret) throw new CalendarError('invalid', 'Paste the client secret too. Google asks for it even for desktop apps.')
      const wanted = await port()
      const scope = scopesFor({ rsvp }).join(' ')
      if (login && login.clientId === id && login.requestedPort === wanted && login.scope === scope) {
        armTimeout()
        return { url: login.url }
      }
      closeLogin()

      const verifier = base64url(randomBytes(48))
      const state = base64url(randomBytes(16))
      const current = { clientId: id, secret, requestedPort: wanted, verifier, state, scope }
      current.server = await listen(wanted, (query) => onCallback(query, current))
      current.redirectUri = `http://127.0.0.1:${current.server.port}/callback`
      const url = new URL(AUTHORIZE_URL)
      url.search = new URLSearchParams({
        client_id: id,
        response_type: 'code',
        redirect_uri: current.redirectUri,
        code_challenge_method: 'S256',
        code_challenge: base64url(createHash('sha256').update(verifier).digest()),
        scope,
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state
      }).toString()
      current.url = url.toString()
      login = current
      result = { status: 'pending' }
      armTimeout()
      return { url: current.url }
    },

    async status() {
      if (login) armTimeout()
      return result
    },

    async connection({ rsvp = false } = {}) {
      const tokens = await load()
      const id = await clientId()
      const connected = Boolean(tokens?.access_token || tokens?.refresh_token) && (!tokens.client_id || tokens.client_id === id)
      const granted = typeof tokens?.scopes === 'string' ? tokens.scopes.split(' ') : []
      return {
        clientId: id || null,
        hasSecret: Boolean(await clientSecret()),
        connected,
        authorizedAt: connected ? tokens.authorized_at : null,
        // calendar.events covers calendar.events.readonly.
        missingScopes: connected ? scopesFor({ rsvp }).filter((s) => !granted.includes(s) && !(s.endsWith('.readonly') && granted.includes(s.replace(/\.readonly$/, '')))) : [],
        protection: memoryOnly ? 'unavailable' : await Promise.resolve(protection()).catch(() => 'unavailable'),
        redirectUri: `http://127.0.0.1:${await port()}/callback`
      }
    },

    async expire() {
      await forget({ ended: true })
    },

    async disconnect() {
      closeLogin()
      result = { status: 'idle' }
      const tokens = await load()
      const token = tokens?.refresh_token ?? tokens?.access_token
      if (token) await post(REVOKE_URL, { token }).catch(() => {})
      await forget()
      return { ok: true }
    },

    close: closeLogin
  }
}

// A one-route HTTP server on 127.0.0.1. `handle(query)` answers each /callback request with
// { status, html, close? }; `close` shuts the server once that page is sent.
export function listenLoopback(port, handle) {
  return new Promise((resolve, reject) => {
    const shutdown = () => {
      server.close()
      server.closeAllConnections?.()
    }
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const { status, html, close } =
        url.pathname === '/callback'
          ? await handle(url.searchParams).catch(() => ({ status: 500, html: page('Something went wrong', 'Go back to Orca and try again.') }))
          : { status: 404, html: page('Not found', '') }
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' })
      res.end(html, () => {
        if (close) shutdown()
      })
    })
    server.once('error', (error) => {
      reject(
        error?.code === 'EADDRINUSE'
          ? new CalendarError('error', `Port ${port} is already in use. Pick another Redirect port in Orca Settings → Calendar.`)
          : new CalendarError('error', `Could not wait for the Google login: ${error?.message ?? error}`)
      )
    })
    server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, close: shutdown }))
  })
}
