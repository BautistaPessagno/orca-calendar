// Stand-ins for Orca's worker host APIs and Google's HTTP endpoints. All data here is made up.

export function fakeSecrets(initial = {}, { failSet = false } = {}) {
  const values = { ...initial }
  return {
    values,
    get: async (key) => values[key] ?? null,
    set: async (key, value) => {
      if (failSet) throw Object.assign(new Error('no keyring'), { code: 'action_failed' })
      values[key] = value
    },
    delete: async (key) => {
      delete values[key]
    }
  }
}

export function fakeSettings(values = {}) {
  return {
    values,
    get: async (key) => values[key],
    set: async (key, value) => {
      values[key] = value
    },
    onDidChange: () => ({ dispose() {} })
  }
}

export function fakeStorage(values = {}) {
  return {
    values,
    get: async (key) => values[key] ?? null,
    set: async (key, value) => {
      values[key] = value
    },
    delete: async (key) => {
      delete values[key]
    }
  }
}

// A fetch Response stand-in with a JSON body.
export function reply(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries(headers)),
    json: async () => body,
    text: async () => (body === undefined ? '' : JSON.stringify(body))
  }
}

// Google stand-in that answers by "METHOD host/path" (query left out), e.g.
// "GET www.googleapis.com/calendar/v3/users/me/calendarList". A route is a reply, a list used in
// turn (the last repeats), or a function of the request.
export function fakeGoogle(routes = {}) {
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url))
    const method = init.method ?? 'GET'
    const key = `${method} ${parsed.host}${decodeURIComponent(parsed.pathname)}`
    const body = typeof init.body === 'string' ? (init.body.startsWith('{') ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body))) : undefined
    const request = { method, key, path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), headers: init.headers ?? {}, body }
    requests.push(request)
    let route = routes[key]
    if (Array.isArray(route)) route = route.length > 1 ? route.shift() : route[0]
    if (typeof route === 'function') route = await route(request)
    if (route instanceof Error) throw route
    return route ?? reply(404, { error: { code: 404, message: 'Not Found' } })
  }
  return { fetchImpl, requests, routes }
}

export const CAL = 'www.googleapis.com/calendar/v3'
export const TOKEN = 'oauth2.googleapis.com/token'
