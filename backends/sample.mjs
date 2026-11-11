// A made-up week, for trying the panel without an account and for screenshots. Today's meetings
// sit around the current time (one running, the next a few minutes away) so every state shows;
// later days use fixed hours. Names, links and rooms are invented.
import { addDays, dayKey, startOfDay } from '../shared/agenda.mjs'
import { findConference } from '../shared/links.mjs'

const CALENDARS = [
  { id: 'work', title: 'Work', color: '#039be5', primary: true, selected: true, account: 'Sample' },
  { id: 'team', title: 'Team', color: '#33b679', primary: false, selected: true, account: 'Sample' },
  { id: 'personal', title: 'Personal', color: '#f4511e', primary: false, selected: true, account: 'Sample' },
  { id: 'holidays', title: 'Holidays', color: '#7986cb', primary: false, selected: false, account: 'Sample' }
]

const ME = { name: 'You', email: 'you@example.com', response: 'accepted', self: true, organizer: false, optional: false }
const people = (names, responses = []) => names.map((name, i) => ({ name, email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`, response: responses[i] ?? 'accepted', self: false, organizer: i === 0, optional: false }))

const MIN = 60_000

export function createSampleBackend({ now = Date.now, timeZone } = {}) {
  // Answers given in the panel, kept in memory only: the sample has no account behind it.
  const answers = new Map()
  const colorOf = (id) => CALENDARS.find((c) => c.id === id).color

  const make = (id, calendarId, title, start, end, extra = {}) => {
    const response = answers.get(id) ?? extra.response ?? 'accepted'
    const attendees = extra.guests ? [...people(extra.guests, extra.guestResponses), { ...ME, response }] : []
    const conference = extra.link ? findConference({ location: extra.link }) : null
    return {
      id,
      calendarId,
      title,
      color: extra.color ?? colorOf(calendarId),
      allDay: typeof start === 'string',
      start,
      end,
      timeZone: null,
      location: extra.location ?? null,
      room: extra.room ?? null,
      description: extra.description ?? null,
      conference,
      attendees,
      attendeesOmitted: false,
      organizer: attendees[0] ? { name: attendees[0].name, email: attendees[0].email, self: false } : null,
      self: attendees.length ? { response, email: ME.email } : null,
      status: 'confirmed',
      busy: extra.busy ?? true,
      recurring: extra.recurring ?? false,
      kind: extra.kind ?? 'default',
      htmlLink: null
    }
  }

  const week = () => {
    const t = now()
    const today = dayKey(t, timeZone)
    const anchor = Math.floor(t / (15 * MIN)) * 15 * MIN
    const day = (n, h, m = 0) => startOfDay(addDays(today, n), timeZone) + (h * 60 + m) * MIN
    const team = ['Lee Park', 'Ana Souza', 'Kai Müller', 'Priya Nair', 'Tom Okafor']
    return [
      make('release', 'team', 'Release week', today, addDays(today, 3)),
      make('standup-0', 'team', 'Daily standup', anchor - 90 * MIN, anchor - 75 * MIN, { guests: team, link: 'https://meet.google.com/abc-defg-hij', recurring: true }),
      make('review', 'work', 'Design review: onboarding', anchor - 15 * MIN, anchor + 30 * MIN, {
        guests: ['Ana Souza', 'Lee Park', 'Priya Nair'],
        guestResponses: ['accepted', 'accepted', 'tentative'],
        link: 'https://acme.zoom.us/j/81234567890',
        room: 'Room 4',
        description: 'Walk through the new onboarding flow.\nBring questions on the empty states.'
      }),
      make('customer', 'work', 'Customer call: Northwind', anchor + 40 * MIN, anchor + 85 * MIN, {
        guests: ['Tom Okafor', 'Jess Lin'],
        response: 'needsAction',
        link: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_sample%40thread.v2/0'
      }),
      make('focus', 'work', 'Focus time', anchor + 2 * 60 * MIN, anchor + 4 * 60 * MIN, { busy: false, kind: 'focusTime' }),
      make('pairing', 'team', 'Pairing with Kai', anchor + 4 * 60 * MIN + 30 * MIN, anchor + 5 * 60 * MIN, { guests: ['Kai Müller'], link: 'https://app.slack.com/huddle/T0SAMPLE1/C0SAMPLE2' }),
      make('standup-1', 'team', 'Daily standup', day(1, 9, 30), day(1, 9, 45), { guests: team, link: 'https://meet.google.com/abc-defg-hij', recurring: true }),
      make('one-on-one', 'work', '1:1 Lee / You', day(1, 11), day(1, 11, 30), { guests: ['Lee Park'], link: 'https://meet.google.com/xyz-abcd-efg', recurring: true }),
      make('allhands', 'work', 'All-hands rehearsal', day(1, 13), day(1, 14), { guests: ['Priya Nair', 'Lee Park'], response: 'declined' }),
      make('lunch', 'personal', 'Lunch with Ana', day(1, 13), day(1, 14), { location: 'Café Lumen, 12 Harbour St' }),
      make('retro', 'team', 'Sprint retro', day(1, 16), day(1, 17), { guests: team, response: 'tentative', link: 'https://meet.google.com/qrs-tuvw-xyz' }),
      make('standup-2', 'team', 'Daily standup', day(2, 9, 30), day(2, 9, 45), { guests: team, link: 'https://meet.google.com/abc-defg-hij', recurring: true }),
      make('planning', 'work', 'Quarter planning', day(2, 10), day(2, 12, 30), { guests: team, room: 'Big room', link: 'https://meet.google.com/jkl-mnop-qrs' }),
      make('dentist', 'personal', 'Dentist', day(2, 17, 30), day(2, 18, 15), { location: 'Smile Clinic' }),
      make('holiday', 'holidays', 'Founders’ Day', addDays(today, 3), addDays(today, 4)),
      make('standup-3', 'team', 'Daily standup', day(3, 9, 30), day(3, 9, 45), { guests: team, link: 'https://meet.google.com/abc-defg-hij', recurring: true })
    ]
  }

  return {
    id: 'sample',
    capabilities: { rsvp: true, conference: true },
    async calendars() {
      return CALENDARS.map((c) => ({ ...c }))
    },
    async events({ from, to, calendars }) {
      const ids = new Set(calendars.map((c) => c.id))
      return week().filter((e) => ids.has(e.calendarId)).filter((e) => (e.allDay ? true : e.end > from && e.start < to))
    },
    async respond(event, response) {
      answers.set(event.id, response)
      return { ...event, self: { ...event.self, response } }
    }
  }
}

// Made-up Google Tasks for the sample week: one overdue, one done, the rest due today and later.
// Ticks are kept in memory only, like the answers above.
const TASK_LISTS = [
  { id: 'my-tasks', title: 'My Tasks' },
  { id: 'errands', title: 'Errands' }
]

export function createSampleTasks({ now = Date.now, timeZone } = {}) {
  const ticks = new Map()
  const all = () => {
    const today = dayKey(now(), timeZone)
    const make = (id, listId, title, offset, extra = {}) => {
      const done = ticks.get(id) ?? extra.done ?? false
      return {
        id,
        listId,
        listTitle: TASK_LISTS.find((l) => l.id === listId).title,
        title,
        notes: extra.notes ?? null,
        due: addDays(today, offset),
        done,
        completedAt: done ? now() : null,
        parentId: null,
        assigned: false,
        link: null
      }
    }
    return [
      make('q4-report', 'my-tasks', 'Send the Q4 report', -1, { notes: 'Numbers from finance, slides from Ana.' }),
      make('review-pr', 'my-tasks', 'Review Ana’s onboarding PR', 0),
      make('flights', 'my-tasks', 'Book flights for the offsite', 0, { done: true }),
      make('passport', 'errands', 'Renew passport', 1),
      make('gift', 'errands', 'Birthday gift for Kai', 2)
    ]
  }
  return {
    async lists() {
      return TASK_LISTS.map((l) => ({ ...l }))
    },
    async tasks({ today, end, lists }) {
      const ids = new Set(lists.map((l) => l.id))
      return all().filter((t) => ids.has(t.listId) && ((!t.done && t.due < today) || (t.due >= today && t.due < end)))
    },
    async setDone(task, done) {
      ticks.set(task.id, done)
      return { ...task, done, completedAt: done ? now() : null }
    }
  }
}
