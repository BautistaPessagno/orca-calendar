// Google Tasks API v1: the person's task lists, the tasks due in the days the agenda shows plus the
// unfinished overdue ones, and ticking one done. Uses the Calendar login; tasks are an extra the
// service reads only when that login has a Tasks scope (docs/specs/tasks/spec.md).
//
// A task's `due` is a date: Google keeps it as midnight UTC, and the API can't read the time a
// task was given in Google Calendar. So the date is the first ten characters, never converted.
import { mapLimited, plainText } from './backend.mjs'

export const TASKS_BASE = 'https://tasks.googleapis.com/tasks/v1'

const PAGES_MAX = 5 // of 100 tasks each, per read
const LISTS_AT_ONCE = 4
const DATE = /^\d{4}-\d{2}-\d{2}/

// 'yyyy-mm-dd' of a due timestamp, or null when it isn't a real day (the panel formats it).
const dueDate = (due) => {
  if (!DATE.test(due ?? '')) return null
  const date = due.slice(0, 10)
  const day = new Date(`${date}T00:00:00.000Z`)
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === date ? date : null
}

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')
const midnight = (date) => `${date}T00:00:00.000Z`

// One Google task as the shared Task shape, or null for what the agenda never shows.
export function normalizeTask(item, list) {
  const due = dueDate(item?.due)
  if (!item || item.deleted || !due) return null
  const completed = Date.parse(item.completed ?? '')
  return {
    id: text(item.id, 1024),
    listId: list.id,
    listTitle: list.title,
    title: text(item.title, 300).trim() || '(No title)',
    notes: plainText(item.notes) || null,
    due,
    done: item.status === 'completed',
    completedAt: Number.isFinite(completed) ? completed : null,
    parentId: text(item.parent, 1024) || null,
    assigned: Boolean(item.assignmentInfo),
    link: typeof item.webViewLink === 'string' && item.webViewLink.startsWith('https://tasks.google.com/') ? item.webViewLink : null
  }
}

export function createGoogleTasks({ client, log = () => {} }) {
  const pages = async (path, query, each) => {
    let pageToken
    for (let page = 0; page < PAGES_MAX; page++) {
      const data = await client.get(path, { ...query, pageToken })
      for (const item of data?.items ?? []) each(item)
      pageToken = data?.nextPageToken
      if (!pageToken) break
    }
  }

  return {
    async lists() {
      const out = []
      await pages('/users/@me/lists', { maxResults: 100 }, (l) => {
        if (l?.id) out.push({ id: l.id, title: text(l.title, 200).trim() || 'Untitled list' })
      })
      return out
    },

    // Unfinished tasks due before `today`, and every task due from `today` up to `end` (exclusive),
    // both 'yyyy-mm-dd'. → { tasks, failed: titles of the lists that couldn't be read }. The first
    // error is thrown only when every list failed.
    async tasks({ today, end, lists }) {
      let firstError = null
      const results = await mapLimited(lists, LISTS_AT_ONCE, async (list) => {
        // By id: Google doesn't say whether dueMax is inclusive, so a task due today may come back
        // from both reads. The second read's copy wins.
        const out = new Map()
        const add = (item) => {
          const task = normalizeTask(item, list)
          if (task) out.set(task.id, task)
        }
        const path = `/lists/${encodeURIComponent(list.id)}/tasks`
        try {
          await pages(path, { maxResults: 100, dueMax: midnight(today), showCompleted: false, showAssigned: true }, add)
          // Tasks ticked in Google's own apps are "hidden" and come back only with showHidden.
          await pages(path, { maxResults: 100, dueMin: midnight(today), dueMax: midnight(end), showCompleted: true, showHidden: true, showAssigned: true }, add)
        } catch (error) {
          firstError ??= error
          log(`tasks: ${String(list.id).slice(0, 6)}…: ${error.message}`)
          return null
        }
        return [...out.values()]
      })
      if (results.length && results.every((r) => r === null)) throw firstError
      return { tasks: results.flatMap((r) => r ?? []), failed: lists.filter((_, i) => results[i] === null).map((l) => l.title) }
    },

    // Only from a press on the task's checkbox in the panel.
    async setDone(task, done) {
      const item = await client.patch(
        `/lists/${encodeURIComponent(task.listId)}/tasks/${encodeURIComponent(task.id)}`,
        done ? { status: 'completed' } : { status: 'needsAction', completed: null }
      )
      return normalizeTask(item, { id: task.listId, title: task.listTitle }) ?? { ...task, done }
    }
  }
}
