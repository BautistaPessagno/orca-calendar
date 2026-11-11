// Google Calendar API backend: the calendar list with the person's own colours, and each shown
// calendar's events with recurring events expanded by Google (singleEvents=true).
import { findConference } from '../../shared/links.mjs'
import { CalendarError } from '../../src/errors.mjs'

// Google Calendar's event colours (colorId 1–11) as its web app draws them.
export const EVENT_COLORS = Object.freeze({
  1: '#7986cb', // Lavender
  2: '#33b679', // Sage
  3: '#8e24aa', // Grape
  4: '#e67c73', // Flamingo
  5: '#f6bf26', // Banana
  6: '#f4511e', // Tangerine
  7: '#039be5', // Peacock
  8: '#616161', // Graphite
  9: '#3f51b5', // Blueberry
  10: '#0b8043', // Basil
  11: '#d50000' // Tomato
})

const DESCRIPTION_MAX = 2000
const PAGES_MAX = 5
const PARALLEL = 4
const RESPONSES = new Set(['accepted', 'tentative', 'declined', 'needsAction'])
const HEX = /^#[0-9a-f]{6}$/i

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

// Event descriptions are HTML from Google's editor; the panel shows plain text.
export function plainText(html) {
  if (typeof html !== 'string') return ''
  return html
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, name) => {
      if (ENTITIES[name.toLowerCase()] !== undefined) return ENTITIES[name.toLowerCase()]
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
        return Number.isFinite(code) && code > 31 && code < 0x110000 ? String.fromCodePoint(code) : ''
      }
      return m
    })
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, DESCRIPTION_MAX)
}

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')

const person = (a) => ({
  name: text(a.displayName, 120) || text(a.email, 120),
  email: text(a.email, 200) || null,
  response: RESPONSES.has(a.responseStatus) ? a.responseStatus : 'needsAction',
  self: a.self === true,
  organizer: a.organizer === true,
  optional: a.optional === true
})

// One Google event as the shared Event shape, or null for what the agenda never shows.
export function normalizeEvent(item, calendar) {
  if (!item || item.status === 'cancelled' || item.eventType === 'workingLocation') return null
  const allDay = Boolean(item.start?.date)
  const start = allDay ? item.start.date : Date.parse(item.start?.dateTime)
  const end = allDay ? (item.end?.date ?? item.start.date) : Date.parse(item.end?.dateTime ?? item.start?.dateTime)
  if (!allDay && (!Number.isFinite(start) || !Number.isFinite(end))) return null

  const attendees = Array.isArray(item.attendees) ? item.attendees : []
  const self = attendees.find((a) => a.self)
  const rooms = attendees.filter((a) => a.resource)
  const color = EVENT_COLORS[item.colorId] ?? (HEX.test(calendar.color ?? '') ? calendar.color : '#039be5')
  const hidden = item.visibility === 'private' && !item.summary

  return {
    id: text(item.id, 1024),
    calendarId: calendar.id,
    title: hidden ? 'Busy' : text(item.summary, 300) || '(No title)',
    color,
    allDay,
    start,
    end,
    timeZone: text(item.start?.timeZone, 64) || null,
    location: text(item.location, 500) || null,
    room: rooms.map((r) => text(r.displayName, 120) || text(r.email, 120)).join(', ') || null,
    description: plainText(item.description) || null,
    conference: findConference({ conferenceData: item.conferenceData, hangoutLink: item.hangoutLink, location: item.location, description: item.description }),
    attendees: attendees.filter((a) => !a.resource).slice(0, 100).map(person),
    attendeesOmitted: item.attendeesOmitted === true,
    organizer: item.organizer ? { name: text(item.organizer.displayName, 120) || text(item.organizer.email, 120), email: text(item.organizer.email, 200) || null, self: item.organizer.self === true } : null,
    self: self ? { response: RESPONSES.has(self.responseStatus) ? self.responseStatus : 'needsAction', email: text(self.email, 200) } : null,
    status: item.status === 'tentative' ? 'tentative' : 'confirmed',
    busy: item.transparency !== 'transparent',
    recurring: Boolean(item.recurringEventId || item.recurrence),
    kind: item.eventType === 'focusTime' || item.eventType === 'outOfOffice' ? item.eventType : 'default',
    htmlLink: typeof item.htmlLink === 'string' && item.htmlLink.startsWith('https://') ? item.htmlLink : null
  }
}

// Runs `fn` over `items`, at most `limit` at a time.
async function mapLimited(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const run = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}

export function createGoogleBackend({ client, log = () => {} }) {
  return {
    id: 'google',
    capabilities: { rsvp: true, conference: true },

    // Answers an invitation for the person: only their own entry, on this one occurrence (an
    // instance id), and Google emails the organizer. PATCH would replace the attendee list, so
    // `attendeesOmitted` tells Google the list holds only the participant.
    async respond(event, response) {
      if (!['accepted', 'tentative', 'declined'].includes(response)) throw new CalendarError('invalid', 'Answer yes, maybe or no.')
      if (!event?.self?.email) throw new CalendarError('invalid', 'You aren’t a guest of this event, so there is nothing to answer.')
      if (event.organizer?.self) throw new CalendarError('invalid', 'You organize this event, so there is nothing to answer.')
      const item = await client.patch(
        `/calendars/${encodeURIComponent(event.calendarId)}/events/${encodeURIComponent(event.id)}`,
        { attendeesOmitted: true, attendees: [{ email: event.self.email, responseStatus: response }] },
        { sendUpdates: 'all' }
      )
      return normalizeEvent(item, { id: event.calendarId, color: event.color }) ?? { ...event, self: { ...event.self, response } }
    },

    async calendars() {
      const out = []
      let pageToken
      for (let page = 0; page < PAGES_MAX; page++) {
        const data = await client.get('/users/me/calendarList', { maxResults: 250, pageToken })
        for (const c of data?.items ?? []) {
          if (c.deleted || c.hidden) continue
          out.push({
            id: c.id,
            title: text(c.summaryOverride, 200) || text(c.summary, 200) || c.id,
            color: HEX.test(c.backgroundColor ?? '') ? c.backgroundColor : '#039be5',
            primary: c.primary === true,
            selected: c.selected !== false,
            account: 'Google'
          })
        }
        pageToken = data?.nextPageToken
        if (!pageToken) break
      }
      return out
    },

    // Events of the given calendars between `from` and `to` (epoch ms). A calendar that fails is
    // logged and left out; the first error is thrown only when every calendar failed.
    async events({ from, to, calendars }) {
      let firstError = null
      const lists = await mapLimited(calendars, PARALLEL, async (calendar) => {
        const items = []
        try {
          let pageToken
          for (let page = 0; page < PAGES_MAX; page++) {
            const data = await client.get(`/calendars/${encodeURIComponent(calendar.id)}/events`, {
              singleEvents: true,
              orderBy: 'startTime',
              timeMin: new Date(from).toISOString(),
              timeMax: new Date(to).toISOString(),
              maxResults: 250,
              maxAttendees: 100,
              pageToken
            })
            for (const item of data?.items ?? []) {
              const event = normalizeEvent(item, calendar)
              if (event) items.push(event)
            }
            pageToken = data?.nextPageToken
            if (!pageToken) break
          }
        } catch (error) {
          firstError ??= error
          log(`google: ${calendar.id.slice(0, 6)}…: ${error.message}`)
          return null
        }
        return items
      })
      if (lists.length && lists.every((list) => list === null)) throw firstError
      return lists.flatMap((list) => list ?? [])
    }
  }
}
