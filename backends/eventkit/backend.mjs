// The Mac's own calendars (whatever accounts macOS has: Google, Exchange, iCloud) through
// EventKit, by running eventkit.js with `osascript -l JavaScript`. No setup beyond one macOS
// prompt, which only `requestAccess` (a press in the panel) can show. Read only: EventKit can't
// answer invitations.
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { addDays, dayKey } from '../../shared/agenda.mjs'
import { findConference } from '../../shared/links.mjs'
import { CalendarError, MESSAGES } from '../../src/errors.mjs'

const SCRIPT = fileURLToPath(new URL('./eventkit.js', import.meta.url))
const TIMEOUT_MS = 10_000
const REQUEST_WAIT_MS = 60_000
const HEX = /^#[0-9a-f]{6}$/i
const GREY = '#8e8e93'
// EKCalendarType: 0 local, 1 CalDAV, 2 Exchange, 3 subscription, 4 birthday.
const BIRTHDAYS = 4
// EKParticipantRole 2: optional; EKParticipantType 2 resource, 3 room.
const OPTIONAL = 2
const ROOMLIKE = new Set([2, 3])

// Runs the script and resolves with its stdout.
export function runOsascript(args, { timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', SCRIPT, ...args], { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

const ACCESS = {
  notDetermined: () => new CalendarError('not-asked', MESSAGES.notAsked),
  denied: () => new CalendarError('no-access', MESSAGES.noAccess),
  writeOnly: () => new CalendarError('no-access', MESSAGES.noAccess),
  restricted: () => new CalendarError('no-access', MESSAGES.restricted)
}

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')

const person = (p) => ({
  name: text(p.name, 120) || text(p.email, 120) || 'Guest',
  email: text(p.email, 200) || null,
  response: p.response ?? 'needsAction',
  self: p.self === true,
  organizer: p.role === 3,
  optional: p.role === OPTIONAL
})

export function normalizeEventKit(raw, calendar, { timeZone } = {}) {
  if (!raw || raw.status === 3 || !Number.isFinite(raw.start) || !Number.isFinite(raw.end)) return null
  const allDay = raw.allDay === true
  const attendees = Array.isArray(raw.attendees) ? raw.attendees : []
  const people = attendees.filter((a) => !ROOMLIKE.has(a.type))
  const rooms = attendees.filter((a) => ROOMLIKE.has(a.type))
  const selfAttendee = attendees.find((a) => a.self)
  const self = selfAttendee
    ? { response: selfAttendee.response ?? 'needsAction', email: text(selfAttendee.email, 200) }
    : raw.organizer?.self
      ? { response: 'accepted', email: text(raw.organizer.email, 200) }
      : null
  return {
    id: `${text(raw.id, 512)}@${raw.start}`,
    calendarId: raw.calendarId,
    title: text(raw.title, 300) || '(No title)',
    color: calendar?.color ?? GREY,
    allDay,
    // EventKit ends an all-day event at 23:59:59 of its last day; the agenda wants the day after.
    start: allDay ? dayKey(raw.start, timeZone) : raw.start,
    end: allDay ? addDays(dayKey(Math.max(raw.start, raw.end - 1), timeZone), 1) : raw.end,
    timeZone: text(raw.timeZone, 64) || null,
    location: text(raw.location, 500) || null,
    room: rooms.map((r) => text(r.name, 120)).filter(Boolean).join(', ') || null,
    description: text(raw.notes, 2000) || null,
    conference: findConference({ location: raw.location, url: raw.url, description: raw.notes }),
    attendees: people.slice(0, 100).map(person),
    attendeesOmitted: false,
    organizer: raw.organizer ? { name: text(raw.organizer.name, 120) || text(raw.organizer.email, 120), email: text(raw.organizer.email, 200) || null, self: raw.organizer.self === true } : null,
    self,
    status: raw.status === 2 ? 'tentative' : 'confirmed',
    // EKEventAvailability 1: free.
    busy: raw.availability !== 1,
    recurring: raw.recurring === true,
    kind: 'default',
    htmlLink: null
  }
}

export function createEventKitBackend({ run = runOsascript, platform = process.platform, timeZone } = {}) {
  const call = async (args, options) => {
    if (platform !== 'darwin') throw new CalendarError('unsupported', MESSAGES.macOnly)
    let out
    try {
      out = JSON.parse(await run(args, options))
    } catch (error) {
      if (error?.killed || error?.signal === 'SIGTERM') throw new CalendarError('error', MESSAGES.timeout)
      throw new CalendarError('error', `Couldn’t read the Mac’s calendars: ${String(error?.message ?? error).slice(0, 200)}`)
    }
    if (out.error) throw new CalendarError('error', `Couldn’t read the Mac’s calendars: ${String(out.error).slice(0, 200)}`)
    if (out.status !== 'fullAccess' && args[0] !== 'request' && args[0] !== 'status') throw (ACCESS[out.status] ?? ACCESS.denied)()
    return out
  }

  const known = new Map()

  return {
    id: 'eventkit',
    capabilities: { rsvp: false, conference: false },

    async accessStatus() {
      return (await call(['status'])).status
    },

    // Shows macOS's prompt (once in the Mac's lifetime for Orca) and waits up to a minute.
    async requestAccess() {
      return (await call(['request', String(REQUEST_WAIT_MS)], { timeout: REQUEST_WAIT_MS + TIMEOUT_MS })).status
    },

    async calendars() {
      const { calendars } = await call(['calendars'])
      const list = (calendars ?? []).map((c) => ({
        id: c.id,
        title: text(c.title, 200) || 'Calendar',
        color: HEX.test(c.color ?? '') ? c.color : GREY,
        primary: false,
        // Birthdays are noise in a meeting agenda; the picker can turn them on.
        selected: c.type !== BIRTHDAYS,
        account: text(c.account, 120) || 'On My Mac'
      }))
      for (const c of list) known.set(c.id, c)
      return list
    },

    async events({ from, to, calendars }) {
      const ids = calendars.map((c) => c.id)
      const { events } = await call(['events', String(from), String(to), JSON.stringify(ids)])
      const byId = new Map(calendars.map((c) => [c.id, c]))
      return (events ?? []).map((raw) => normalizeEventKit(raw, byId.get(raw.calendarId) ?? known.get(raw.calendarId), { timeZone })).filter(Boolean)
    }
  }
}
