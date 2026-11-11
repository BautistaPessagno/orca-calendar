// Reads the Mac's calendar store through EventKit. Run with
//   osascript -l JavaScript eventkit.js <mode> [fromMs] [toMs] [calendarIdsJson]
// mode: status | request | calendars | events. Prints one JSON object. Never writes.
// Recurring events come back as one entry per occurrence, as EventKit expands them.
ObjC.import('EventKit')
ObjC.import('AppKit')
ObjC.import('Foundation')

const STATUS = ['notDetermined', 'restricted', 'denied', 'fullAccess', 'writeOnly']
const RESPONSE = { 0: null, 1: 'needsAction', 2: 'accepted', 3: 'declined', 4: 'tentative', 5: 'accepted', 6: 'accepted', 7: 'needsAction' }

const str = (value) => (value && !value.isNil() ? ObjC.unwrap(value) : null)
const ms = (date) => (date && !date.isNil() ? Math.round(date.timeIntervalSince1970 * 1000) : null)

function status() {
  return STATUS[$.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent)] || 'notDetermined'
}

function hex(color) {
  if (!color || color.isNil()) return null
  const c = color.colorUsingColorSpace($.NSColorSpace.sRGBColorSpace)
  if (!c || c.isNil()) return null
  const h = (v) => ('0' + Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16)).slice(-2)
  return '#' + h(c.redComponent) + h(c.greenComponent) + h(c.blueComponent)
}

function person(p) {
  const url = p.URL && !p.URL.isNil() ? ObjC.unwrap(p.URL.absoluteString) : ''
  return {
    name: str(p.name),
    email: url.indexOf('mailto:') === 0 ? decodeURIComponent(url.slice(7)) : null,
    response: RESPONSE[p.participantStatus] === undefined ? 'needsAction' : RESPONSE[p.participantStatus],
    self: Boolean(p.isCurrentUser),
    role: Number(p.participantRole),
    type: Number(p.participantType)
  }
}

// Asks once, then waits for the answer by watching the status (the completion block does not
// reliably reach a JXA run loop). Gives up after `waitMs`; never asks twice.
function request(waitMs) {
  if (status() !== 'notDetermined') return status()
  const store = $.EKEventStore.alloc.init
  const done = () => {}
  if (store.respondsToSelector('requestFullAccessToEventsWithCompletion:')) store.requestFullAccessToEventsWithCompletion(done)
  else store.requestAccessToEntityTypeCompletion($.EKEntityTypeEvent, done)
  const deadline = Date.now() + waitMs
  while (status() === 'notDetermined' && Date.now() < deadline) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.25))
  return status()
}

function calendars(store) {
  const list = store.calendarsForEntityType($.EKEntityTypeEvent)
  const out = []
  for (let i = 0; i < list.count; i++) {
    const c = list.objectAtIndex(i)
    out.push({ id: str(c.calendarIdentifier), title: str(c.title), color: hex(c.color), account: str(c.source.title), type: Number(c.type) })
  }
  return out
}

function events(store, from, to, ids) {
  const all = store.calendarsForEntityType($.EKEntityTypeEvent)
  const wanted = $.NSMutableArray.array
  for (let i = 0; i < all.count; i++) {
    const c = all.objectAtIndex(i)
    if (!ids || ids.indexOf(str(c.calendarIdentifier)) >= 0) wanted.addObject(c)
  }
  if (wanted.count === 0) return []
  const predicate = store.predicateForEventsWithStartDateEndDateCalendars($.NSDate.dateWithTimeIntervalSince1970(from / 1000), $.NSDate.dateWithTimeIntervalSince1970(to / 1000), wanted)
  const found = store.eventsMatchingPredicate(predicate)
  const out = []
  for (let i = 0; i < found.count && out.length < 2000; i++) {
    const e = found.objectAtIndex(i)
    const attendees = []
    if (!e.attendees.isNil()) for (let j = 0; j < e.attendees.count && j < 100; j++) attendees.push(person(e.attendees.objectAtIndex(j)))
    out.push({
      id: str(e.eventIdentifier),
      calendarId: str(e.calendar.calendarIdentifier),
      title: str(e.title),
      allDay: Boolean(e.allDay),
      start: ms(e.startDate),
      end: ms(e.endDate),
      timeZone: e.timeZone.isNil() ? null : str(e.timeZone.name),
      location: str(e.location),
      url: e.URL.isNil() ? null : ObjC.unwrap(e.URL.absoluteString),
      notes: (str(e.notes) || '').slice(0, 20000),
      attendees: attendees,
      organizer: e.organizer.isNil() ? null : person(e.organizer),
      status: Number(e.status),
      availability: Number(e.availability),
      recurring: Boolean(e.hasRecurrenceRules)
    })
  }
  return out
}

function run(argv) {
  const mode = argv[0]
  try {
    if (mode === 'status') return JSON.stringify({ status: status() })
    if (mode === 'request') return JSON.stringify({ status: request(Number(argv[1]) || 60000) })
    if (status() !== 'fullAccess') return JSON.stringify({ status: status() })
    const store = $.EKEventStore.alloc.init
    if (mode === 'calendars') return JSON.stringify({ status: 'fullAccess', calendars: calendars(store) })
    if (mode === 'events') return JSON.stringify({ status: 'fullAccess', events: events(store, Number(argv[1]), Number(argv[2]), argv[3] ? JSON.parse(argv[3]) : null) })
    return JSON.stringify({ error: 'unknown mode' })
  } catch (error) {
    return JSON.stringify({ error: String(error && error.message ? error.message : error) })
  }
}
