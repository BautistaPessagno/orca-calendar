// A desktop notification a set number of minutes before each meeting (settings `notify` and
// `notifyMinutes`). Each meeting is announced once; what was announced is kept in storage so a
// worker restart doesn't repeat it.
import { counts } from '../shared/agenda.mjs'
import { clip, formatDuration, formatRange, where } from '../shared/format.mjs'

const KEY = 'notified'
const KEEP_MS = 2 * 24 * 3600_000

const keyOf = (event) => `${event.id}@${event.start}`

export function createReminders({ host, storage, format = () => ({}), log = () => {} }) {
  let notified = null // { key: start }

  const load = async () => {
    if (notified) return notified
    const stored = await Promise.resolve(storage.get(KEY)).catch(() => null)
    notified = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {}
    return notified
  }

  const leadOf = (settings) => (settings?.notify === false ? null : Math.max(0, Math.min(60, Number(settings?.notifyMinutes ?? 5) || 0)) * 60_000)

  return {
    // When the next reminder is due, so the worker's timer wakes for it.
    nextAt(events, now, settings) {
      const lead = leadOf(settings)
      if (lead === null) return null
      let soonest = null
      for (const event of events) {
        if (!counts(event, settings) || event.start <= now) continue
        const due = event.start - lead
        if (due > now && (soonest === null || due < soonest)) soonest = due
      }
      return soonest
    },

    async check(events, now, settings) {
      const lead = leadOf(settings)
      if (lead === null) return
      const done = await load()
      let changed = false
      for (const event of events) {
        if (!counts(event, settings)) continue
        // Due from `lead` before the start until it starts; a meeting already running is not news.
        if (now < event.start - lead || now > event.start) continue
        const key = keyOf(event)
        if (done[key]) continue
        done[key] = event.start
        changed = true
        const left = event.start - now
        const title = clip(event.title || 'Busy', 80) + (left < 60_000 ? ' starts now' : ` in ${formatDuration(left)}`)
        const body = [formatRange(event.start, event.end, format()), where(event)].filter(Boolean).join(' · ')
        try {
          await host.call('notifications.show', { title, body })
        } catch (error) {
          log(`notification: ${error.code ?? error.message}`)
        }
      }
      for (const [key, start] of Object.entries(done)) {
        if (start < now - KEEP_MS) {
          delete done[key]
          changed = true
        }
      }
      if (changed) await Promise.resolve(storage.set(KEY, done)).catch((error) => log(`storage: ${error.message}`))
    }
  }
}
