// Times and durations as people read them, in Orca's locale and zone. Shared by panel and worker.

const cache = new Map()
const formatter = (locale, options) => {
  const key = JSON.stringify([locale, options])
  if (!cache.has(key)) {
    try {
      cache.set(key, new Intl.DateTimeFormat(locale, options))
    } catch {
      cache.set(key, new Intl.DateTimeFormat(undefined, options))
    }
  }
  return cache.get(key)
}

export const formatTime = (ms, { locale, timeZone } = {}) => formatter(locale, { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(ms))

export const formatRange = (start, end, options) => `${formatTime(start, options)}–${formatTime(end, options)}`

// "12 min", "1 h", "1 h 5 min"; rounds up to whole minutes.
export function formatDuration(ms) {
  const minutes = Math.max(0, Math.ceil(ms / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

export const clip = (text, max) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? value.slice(0, max - 1).trimEnd() + '…' : value
}

// What a meeting is held on or in: the call's name, else the location.
export const where = (event) => event.conference?.label ?? (event.location ? clip(event.location, 60) : '')
