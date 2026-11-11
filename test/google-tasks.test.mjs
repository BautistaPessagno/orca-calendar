import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient } from '../backends/google/client.mjs'
import { createGoogleTasks, normalizeTask, TASKS_BASE } from '../backends/google/tasks.mjs'
import { fakeGoogle, reply } from './fakes.mjs'

const TASKS = 'tasks.googleapis.com/tasks/v1'
const auth = { getAccessToken: async () => 'at', expire: async () => {} }
const list = { id: 'list-1', title: 'My Tasks' }

const setup = (routes) => {
  const google = fakeGoogle(routes)
  const client = createClient({ auth, fetchImpl: google.fetchImpl, base: TASKS_BASE, api: 'Google Tasks' })
  const logs = []
  return { google, tasks: createGoogleTasks({ client, log: (line) => logs.push(line) }), logs }
}

test('normalizes a Google task: the due date stays a date, never shifted by a time zone', () => {
  const task = normalizeTask(
    {
      id: 't1',
      title: 'Send the Q4 report',
      notes: 'Numbers from finance',
      status: 'needsAction',
      due: '2026-11-12T00:00:00.000Z',
      parent: 'p1',
      webViewLink: 'https://tasks.google.com/task/abc',
      assignmentInfo: { surfaceType: 'DOCUMENT' }
    },
    list
  )
  assert.deepEqual(task, {
    id: 't1',
    listId: 'list-1',
    listTitle: 'My Tasks',
    title: 'Send the Q4 report',
    notes: 'Numbers from finance',
    due: '2026-11-12',
    done: false,
    completedAt: null,
    parentId: 'p1',
    assigned: true,
    link: 'https://tasks.google.com/task/abc'
  })
  const done = normalizeTask({ id: 't2', title: '', status: 'completed', completed: '2026-11-11T08:00:00.000Z', due: '2026-11-11T00:00:00.000Z', webViewLink: 'javascript:alert(1)' }, list)
  assert.equal(done.title, '(No title)')
  assert.equal(done.done, true)
  assert.equal(done.completedAt, Date.parse('2026-11-11T08:00:00Z'))
  assert.equal(done.link, null)
  // No due date: Google Calendar doesn't show it, and neither does the agenda.
  assert.equal(normalizeTask({ id: 't3', title: 'Someday', status: 'needsAction' }, list), null)
  assert.equal(normalizeTask({ id: 't4', title: 'Gone', deleted: true, due: '2026-11-11T00:00:00.000Z' }, list), null)
})

test('reads the task lists, page by page', async () => {
  const { tasks, google } = setup({
    [`GET ${TASKS}/users/@me/lists`]: [reply(200, { items: [{ id: 'a', title: 'My Tasks' }], nextPageToken: 'p2' }), reply(200, { items: [{ id: 'b', title: '' }] })]
  })
  assert.deepEqual(await tasks.lists(), [
    { id: 'a', title: 'My Tasks' },
    { id: 'b', title: 'Untitled list' }
  ])
  assert.equal(google.requests[1].query.pageToken, 'p2')
})

test('reads overdue tasks and the tasks due in the days shown, with the ones ticked in Google apps', async () => {
  const { tasks, google } = setup({
    [`GET ${TASKS}/lists/list-1/tasks`]: (request) =>
      request.query.dueMin
        ? reply(200, { items: [{ id: 'today', title: 'Today', status: 'completed', due: '2026-11-11T00:00:00.000Z' }] })
        : reply(200, { items: [{ id: 'late', title: 'Late', status: 'needsAction', due: '2026-11-09T00:00:00.000Z' }] })
  })
  const got = await tasks.tasks({ today: '2026-11-11', end: '2026-11-14', lists: [list] })
  assert.deepEqual(got.map((t) => [t.id, t.due, t.done]), [['late', '2026-11-09', false], ['today', '2026-11-11', true]])
  const [overdue, range] = google.requests.map((r) => r.query)
  assert.equal(overdue.dueMax, '2026-11-11T00:00:00.000Z')
  assert.equal(overdue.showCompleted, 'false')
  assert.equal(overdue.dueMin, undefined)
  assert.equal(range.dueMin, '2026-11-11T00:00:00.000Z')
  assert.equal(range.dueMax, '2026-11-14T00:00:00.000Z')
  assert.equal(range.showCompleted, 'true')
  assert.equal(range.showHidden, 'true')
  assert.equal(range.showAssigned, 'true')
})

test('one list failing leaves it out; every list failing throws', async () => {
  const lists = [list, { id: 'list-2', title: 'Errands' }]
  const { tasks, logs } = setup({
    [`GET ${TASKS}/lists/list-1/tasks`]: reply(500, { error: { message: 'Backend Error' } }),
    [`GET ${TASKS}/lists/list-2/tasks`]: reply(200, { items: [{ id: 'milk', title: 'Milk', status: 'needsAction', due: '2026-11-11T00:00:00.000Z' }] })
  })
  assert.deepEqual((await tasks.tasks({ today: '2026-11-11', end: '2026-11-12', lists })).map((t) => t.id), ['milk'])
  assert.equal(logs.length, 1)
  const broken = setup({ [`GET ${TASKS}/lists/list-1/tasks`]: reply(500, { error: { message: 'Backend Error' } }) })
  await assert.rejects(broken.tasks.tasks({ today: '2026-11-11', end: '2026-11-12', lists: [list] }), /Backend Error/)
})

test('a disabled Tasks API and a missing permission are told apart', async () => {
  const disabled = setup({
    [`GET ${TASKS}/users/@me/lists`]: reply(403, { error: { code: 403, message: 'Google Tasks API has not been used in project 123 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } })
  })
  await assert.rejects(disabled.tasks.lists(), (e) => e.reason === 'api-disabled' && /Google Tasks API/.test(e.message))
  const scope = setup({
    [`GET ${TASKS}/users/@me/lists`]: reply(403, { error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED', errors: [{ reason: 'insufficientPermissions' }] } })
  })
  await assert.rejects(scope.tasks.lists(), (e) => e.reason === 'scope')
})

test('ticks a task done and undoes it', async () => {
  const { tasks, google } = setup({
    [`PATCH ${TASKS}/lists/list-1/tasks/t1`]: (request) =>
      reply(200, { id: 't1', title: 'Report', status: request.body.status, due: '2026-11-11T00:00:00.000Z', ...(request.body.status === 'completed' ? { completed: '2026-11-11T09:00:00.000Z' } : {}) })
  })
  const task = { id: 't1', listId: 'list-1', listTitle: 'My Tasks', title: 'Report', due: '2026-11-11', done: false }
  const done = await tasks.setDone(task, true)
  assert.equal(done.done, true)
  assert.deepEqual(google.requests[0].body, { status: 'completed' })
  const undone = await tasks.setDone(done, false)
  assert.equal(undone.done, false)
  assert.deepEqual(google.requests[1].body, { status: 'needsAction', completed: null })
  assert.equal(undone.listTitle, 'My Tasks')
})
