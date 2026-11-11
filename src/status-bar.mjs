// The status bar item: the next meeting with a countdown, "now" while one runs, hidden when
// nothing starts within the hour. Status bar items take plain text (no live relative time), so
// the ticker works out the next moment the text changes and sets one timer for it. It never
// reads the calendar; the worker hands it events whenever it has new ones.
import { meetingState } from '../shared/agenda.mjs'
import { clip, formatDuration, formatRange, where } from '../shared/format.mjs'

export const ITEM_ID = 'next-meeting'
export const LEAD_MS = 60 * 60_000
export const WARN_MS = 5 * 60_000
const TITLE_MAX = 32
const TOOLTIP_MAX = 256
// Wake at least this often anyway, in case the machine slept through a timer.
const MAX_SLEEP_MS = 15 * 60_000

const describe = (event, format) => [clip(event.title, 80), formatRange(event.start, event.end, format), where(event)].filter(Boolean).join(' · ')

// Which meeting the item is about at `now`: the next one when it starts within five minutes
// (back-to-back meetings), else the running one, else the next one within the lead time.
function pick(events, now, { leadMs = LEAD_MS, warnMs = WARN_MS, hidden } = {}) {
  const { current, next } = meetingState(events, now, { hidden })
  if (next && next.start - now <= warnMs) return { event: next, running: false }
  if (current) return { event: current, running: true }
  if (next && next.start - now <= leadMs) return { event: next, running: false }
  return null
}

// { text, icon, tone, tooltip } for the item, or null to hide it.
export function statusBarView(events, now, options = {}) {
  const shown = pick(events, now, options)
  if (!shown) return null
  const { event, running } = shown
  const title = clip(event.title || 'Busy', TITLE_MAX)
  const tooltip = describe(event, options)
  if (running) {
    return { text: `${title} now`, icon: 'calendar', tone: 'accent', tooltip: clip(`${tooltip} · ends in ${formatDuration(event.end - now)}`, TOOLTIP_MAX) }
  }
  const left = event.start - now
  return {
    text: `${title} in ${formatDuration(left)}`,
    icon: 'calendar',
    tone: left <= (options.warnMs ?? WARN_MS) ? 'warning' : 'neutral',
    tooltip: clip(tooltip, TOOLTIP_MAX)
  }
}

// The next instant after `now` at which statusBarView may say something else, or null.
export function nextChange(events, now, { leadMs = LEAD_MS, warnMs = WARN_MS, hidden } = {}) {
  let soonest = Infinity
  const consider = (t) => {
    if (t > now && t < soonest) soonest = t
  }
  const shown = pick(events, now, { leadMs, warnMs, hidden })
  if (shown && !shown.running) {
    // The countdown drops a minute when the time left reaches the next whole minute below.
    const left = shown.event.start - now
    const minutes = Math.ceil(left / 60_000)
    consider(shown.event.start - (minutes - 1) * 60_000)
  }
  for (const event of events) {
    if (event.allDay || event.end <= now) continue
    consider(event.start - leadMs)
    consider(event.start - warnMs)
    consider(event.start)
    consider(event.end)
  }
  return soonest === Infinity ? null : soonest
}

// Keeps the item current. `update(events)` takes a new agenda; between agendas the item changes
// on its own timer. `extraWake(now)` lets the worker add its own wake-ups (reminders).
export function createTicker({ host, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, format = () => ({}), log = () => {}, onTick = async () => {}, extraWake = () => null }) {
  let events = []
  let options = {}
  let shown
  let timer = null
  let stopped = false

  const send = async (view) => {
    const key = JSON.stringify(view)
    if (key === shown) return
    shown = key
    try {
      await host.call('statusBar.update', view ? { id: ITEM_ID, visible: true, ...view } : { id: ITEM_ID, visible: false })
    } catch (error) {
      log(`status bar: ${error.code ?? error.message}`)
    }
  }

  const tick = async () => {
    timer = null
    if (stopped) return
    const t = now()
    await send(statusBarView(events, t, { ...format(), ...options }))
    await onTick(events, t)
    const wakes = [nextChange(events, t, options), extraWake(events, t)].filter((w) => w !== null && w > t)
    const at = Math.min(t + MAX_SLEEP_MS, ...wakes)
    clearTimer(timer)
    timer = setTimer(tick, Math.max(1000, at - t))
    timer?.unref?.()
  }

  return {
    async update(next, nextOptions = options) {
      events = next
      options = nextOptions
      clearTimer(timer)
      await tick()
    },
    async hide() {
      events = []
      await send(null)
    },
    stop() {
      stopped = true
      clearTimer(timer)
      timer = null
    }
  }
}
