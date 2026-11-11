// The agenda: which events show on which day, in what order, where the free time and the "now"
// line go, and which meeting is running or next. Pure, so the panel and the worker share it.
//
// Events are the normalized shape every backend returns (docs/specs/calendar/spec.md): timed
// events carry epoch ms, all-day events 'yyyy-mm-dd' dates with an exclusive end. Days are split
// in `timeZone` (undefined: this machine's zone), so DST days are 23 or 25 hours long.

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
export const MIN_GAP_MS = 30 * MINUTE

const partsCache = new Map()
const formatter = (timeZone) => {
  const key = timeZone ?? ''
  if (!partsCache.has(key)) {
    partsCache.set(
      key,
      new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    )
  }
  return partsCache.get(key)
}

const wallClock = (ms, timeZone) => {
  const parts = {}
  for (const { type, value } of formatter(timeZone).formatToParts(new Date(ms))) parts[type] = Number(value)
  return parts
}

// 'yyyy-mm-dd' of the instant in the zone.
export function dayKey(ms, timeZone) {
  const { year, month, day } = wallClock(ms, timeZone)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// Offset of the zone from UTC at an instant, in ms.
const offsetAt = (ms, timeZone) => {
  const p = wallClock(ms, timeZone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000
}

// The instant the day begins in the zone.
export function startOfDay(date, timeZone) {
  const [y, m, d] = date.split('-').map(Number)
  const utc = Date.UTC(y, m - 1, d)
  let guess = utc - offsetAt(utc, timeZone)
  guess = utc - offsetAt(guess, timeZone)
  return guess
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

const declined = (event) => event.self?.response === 'declined'

// Shown at all: not cancelled, not on a hidden calendar, declined only when asked.
export function visible(event, { hidden = [], showDeclined = false } = {}) {
  if (event.status === 'cancelled') return false
  if (hidden.includes(event.calendarId)) return false
  return showDeclined || !declined(event)
}

// Counts for the status bar and reminders: a timed meeting the person blocks time for.
export const counts = (event, options) => !event.allDay && event.busy !== false && !declined(event) && visible(event, options)

const byTime = (a, b) => a.start - b.start || a.end - b.end || String(a.title).localeCompare(String(b.title))

// { days: [{ date, today, start, end, allDay: Event[], items: Item[] }], current: id[] }
// Item: { type: 'event', event, continued?, continues? } | { type: 'gap', start, end } | { type: 'now', at }
export function buildAgenda(events, { now, days = 3, timeZone, hidden = [], showDeclined = false, minGapMs = MIN_GAP_MS } = {}) {
  const shown = events.filter((event) => visible(event, { hidden, showDeclined }))
  const timed = shown.filter((event) => !event.allDay).sort(byTime)
  const allDay = shown.filter((event) => event.allDay).sort((a, b) => a.start.localeCompare(b.start) || String(a.title).localeCompare(String(b.title)))
  const today = dayKey(now, timeZone)
  const result = { days: [], current: [] }

  for (const event of timed) if (event.start <= now && now < event.end && !declined(event)) result.current.push(event.id)

  for (let i = 0; i < days; i++) {
    const date = addDays(today, i)
    const start = startOfDay(date, timeZone)
    const end = startOfDay(addDays(date, 1), timeZone)
    const day = {
      date,
      today: i === 0,
      start,
      end,
      allDay: allDay.filter((event) => event.start <= date && date < event.end),
      items: []
    }
    for (const event of timed) {
      if (event.end <= start || event.start >= end) continue
      // A zero-length event on this day still shows.
      if (event.start === event.end && event.start < start) continue
      const item = { type: 'event', event }
      if (event.start < start) item.continued = true
      if (event.end > end) item.continues = true
      day.items.push(item)
    }
    placeNowAndGaps(day, now, minGapMs, i === 0)
    result.days.push(day)
  }
  return result
}

// Free time of at least `minGapMs` between busy meetings, and (today) the "now" line, merged
// into the day's events in time order. On later days free time starts at the first meeting;
// today it starts now, so the time before the next meeting counts too.
function placeNowAndGaps(day, now, minGapMs, isToday) {
  const gaps = []
  let busyUntil = isToday ? now : null
  for (const { event } of day.items) {
    if (event.busy === false || declined(event)) continue
    const from = busyUntil === null ? null : Math.max(busyUntil, day.start)
    if (from !== null && event.start - from >= minGapMs && event.start > now) gaps.push({ type: 'gap', start: Math.max(from, isToday ? now : from), end: event.start })
    busyUntil = busyUntil === null ? event.end : Math.max(busyUntil, event.end)
  }
  const keyed = day.items.map((item) => [item.continued ? day.start : item.event.start, 0, item])
  for (const gap of gaps) keyed.push([gap.start, 2, gap])
  if (isToday && now >= day.start && now < day.end) keyed.push([now, 1, { type: 'now', at: now }])
  // Events that already started sit before the now line; a gap from now sits after it.
  keyed.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  day.items = keyed.map(([, , item]) => item)
}

// The meeting running now (the one that started last) and the next one to start.
export function meetingState(events, now, options) {
  let current = null
  let next = null
  for (const event of events) {
    if (!counts(event, options)) continue
    if (event.start <= now && now < event.end) {
      if (!current || event.start > current.start) current = event
    } else if (event.start > now && (!next || byTime(event, next) < 0)) {
      next = event
    }
  }
  return { current, next }
}

export const time = { MINUTE, DAY }
