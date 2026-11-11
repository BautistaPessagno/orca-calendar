// A Google API over fetch, with the login's access token: Calendar API v3 by default, Tasks API v1
// with `base` and `api`. A 401 refreshes the token once; a second 401 ends the login. Errors become
// CalendarErrors with a sentence the panel shows, and a `reason` ('api-disabled', 'scope') for
// callers that treat those apart.
import { CalendarError, MESSAGES } from '../../src/errors.mjs'

export const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3'
const TIMEOUT_MS = 15_000

const reasonOf = (body) => body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? ''

export function createClient({ auth, fetchImpl = globalThis.fetch, base = CALENDAR_BASE, api = 'Google Calendar' }) {
  async function send(method, path, { query, body } = {}, retried = false) {
    const token = await auth.getAccessToken({ force: retried })
    const url = new URL(base + path)
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch (error) {
      throw new CalendarError('offline', MESSAGES.offline, { cause: error })
    }
    const data = response.status === 204 ? null : await response.json().catch(() => null)
    if (response.ok) return data
    if (response.status === 401) {
      if (!retried) return send(method, path, { query, body }, true)
      await auth.expire()
      throw new CalendarError('unauthenticated', MESSAGES.unauthenticated)
    }
    const reason = reasonOf(data)
    if (response.status === 429 || /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/.test(reason)) {
      throw new CalendarError('rate-limited', MESSAGES.rateLimited, { retryAfterMs: 60_000 })
    }
    if (reason === 'accessNotConfigured' || /has not been used in project|is disabled/.test(data?.error?.message ?? '')) {
      throw new CalendarError('error', `Enable the ${api} API in your Google Cloud project (APIs & Services → Library → ${api} API → Enable), wait a minute, then refresh.`, { reason: 'api-disabled' })
    }
    if (response.status === 403 && /insufficient|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(reason + (data?.error?.message ?? ''))) {
      throw new CalendarError('unauthenticated', 'Calendar needs a permission your Google login didn’t give. Connect again and allow it.', { reason: 'scope' })
    }
    const detail = String(data?.error?.message ?? `HTTP ${response.status}`).slice(0, 200)
    throw new CalendarError('error', `${api} answered: ${detail}`, { status: response.status })
  }

  return {
    get: (path, query) => send('GET', path, { query }),
    patch: (path, body, query) => send('PATCH', path, { body, query })
  }
}
