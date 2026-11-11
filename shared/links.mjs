// Meeting links: which ones the join button opens, and where to find one in an event.
// Shared by the worker (to pick the link) and the panel (to check it again before opening).
// Event text is untrusted, so only https links on known hosts count, with no user:password part.

const LABELS = { meet: 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams', slack: 'Slack huddle', other: 'Video call' }

// [kind, host test, path test]
const RULES = [
  ['meet', (h) => h === 'meet.google.com', (p) => /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i.test(p) || /^\/lookup\/[\w-]+$/.test(p)],
  ['zoom', (h) => /^([a-z0-9-]+\.)?zoom(gov)?\.(us|com)$/.test(h), (p) => /^\/(j|my|w|s)\/[\w.-]+\/?$/.test(p)],
  ['teams', (h) => h === 'teams.microsoft.com', (p) => p.startsWith('/l/meetup-join/') || p.startsWith('/meet/')],
  ['teams', (h) => h === 'teams.live.com', (p) => p.startsWith('/meet/')],
  ['slack', (h) => h === 'app.slack.com' || /^[a-z0-9-]+\.slack\.com$/.test(h), (p) => /^\/huddle\/[A-Z0-9]+\/[A-Z0-9]+\/?$/.test(p)]
]

const parse = (value) => {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

// 'meet' | 'zoom' | 'teams' | 'slack', or null when the join button must not open it.
export function joinKind(value) {
  const url = parse(value)
  if (!url) return null
  const host = url.hostname.toLowerCase()
  for (const [kind, hostOk, pathOk] of RULES) if (hostOk(host) && pathOk(url.pathname)) return kind
  return null
}

const URL_IN_TEXT = /https:\/\/[^\s"'<>()]+/g

const trim = (url) => url.replace(/[.,;:!?)\]}]+$/, '')

const fromText = (text) => {
  if (typeof text !== 'string') return null
  for (const match of text.slice(0, 20_000).matchAll(URL_IN_TEXT)) {
    const url = trim(match[0].replace(/&amp;/g, '&'))
    const kind = joinKind(url)
    if (kind) return { kind, url, label: LABELS[kind] }
  }
  return null
}

// The meeting link of an event: Google's conference data, its older hangoutLink, then the first
// known link in the location, the URL field and the notes.
export function findConference({ conferenceData, hangoutLink, location, url, description } = {}) {
  const video = conferenceData?.entryPoints?.find?.((entry) => entry?.entryPointType === 'video')
  if (video) {
    const kind = joinKind(video.uri)
    if (kind) return { kind, url: video.uri, label: LABELS[kind] }
    if (parse(video.uri)) {
      const name = String(conferenceData.conferenceSolution?.name ?? '').slice(0, 40)
      return { kind: 'other', url: video.uri, label: name || LABELS.other }
    }
  }
  if (joinKind(hangoutLink)) return { kind: 'meet', url: hangoutLink, label: LABELS.meet }
  return fromText(location) ?? (joinKind(url) ? { kind: joinKind(url), url, label: LABELS[joinKind(url)] } : null) ?? fromText(description)
}

// What the panel checks before `shell.openExternal`: a known meeting link, or the https link the
// worker kept as 'other' (from Google's own conference data).
export function openable(conference) {
  if (!conference || typeof conference.url !== 'string') return false
  return conference.kind === 'other' ? Boolean(parse(conference.url)) : joinKind(conference.url) === conference.kind
}
