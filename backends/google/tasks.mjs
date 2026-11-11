// Google Tasks API v1: the person's task lists, the tasks due in the days the agenda shows plus the
// unfinished overdue ones, and ticking one done. Uses the Calendar login; tasks are an extra the
// service reads only when that login has a Tasks scope (docs/specs/tasks/spec.md).
//
// A task's `due` is a date: Google keeps it as midnight UTC, and the API can't read the time a
// task was given in Google Calendar. So the date is the first ten characters, never converted.
import { plainText } from './backend.mjs'

export const TASKS_BASE = 'https://tasks.googleapis.com/tasks/v1'

const PAGES_MAX = 5
const PARALLEL = 4
const DATE = /^\d{4}-\d{2}-\d{2}/

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')
const midnight = (date) => `${date}T00:00:00.000Z`

// One Google task as the shared Task shape, or null for what the agenda never shows.
export function normalizeTask(item, list) {
  if (!item || item.deleted || !DATE.test(item.due ?? '')) return null
  const completed = Date.parse(item.completed ?? '')
  return {
    id: text(item.id, 1024),
    listId: list.id,
    listTitle: list.title,
    title: text(item.title, 300).trim() || '(No title)',
    notes: plainText(item.notes) || null,
    due: item.due.slice(0, 10),
    done: item.status === 'completed',
    completedAt: Number.isFinite(completed) ? completed : null,
    parentId: text(item.parent, 1024) || null,
    assigned: Boolean(item.assignmentInfo),
    link: typeof item.webViewLink === 'string' && item.webViewLink.startsWith('https://tasks.google.com/') ? item.webViewLink : null
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
    // both 'yyyy-mm-dd'. A list that fails is logged and left out; the first error is thrown only
    // when every list failed.
    async tasks({ today, end, lists }) {
      let firstError = null
      const results = await mapLimited(lists, PARALLEL, async (list) => {
        // By id: Google doesn't say whether dueMax is inclusive, so a task due today may come back
        // from both reads. The second read's copy wins.
        const out = new Map()
        const keep = (item) => {
          const task = normalizeTask(item, list)
          if (task) out.set(task.id, task)
        }
        const path = `/lists/${encodeURIComponent(list.id)}/tasks`
        try {
          await pages(path, { maxResults: 100, dueMax: midnight(today), showCompleted: false, showAssigned: true }, keep)
          // Tasks ticked in Google's own apps are "hidden" and come back only with showHidden.
          await pages(path, { maxResults: 100, dueMin: midnight(today), dueMax: midnight(end), showCompleted: true, showHidden: true, showAssigned: true }, keep)
        } catch (error) {
          firstError ??= error
          log(`tasks: ${String(list.id).slice(0, 6)}…: ${error.message}`)
          return null
        }
        return [...out.values()]
      })
      if (results.length && results.every((r) => r === null)) throw firstError
      return results.flatMap((r) => r ?? [])
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
