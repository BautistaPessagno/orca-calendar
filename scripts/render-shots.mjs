// Renders the real panel/index.html in headless Chrome, in Orca's light and dark tokens, for
// every state worth checking. A stand-in window.orca answers the panel's requests from the
// sample backend, so no real calendar data ever reaches an image.
//
//   node scripts/render-shots.mjs [outDir] [state…]
//
// Needs Google Chrome (or set CHROME to a Chrome or Chromium binary).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSampleBackend, createSampleTasks } from '../backends/sample.mjs'
import { MESSAGES } from '../src/errors.mjs'
import { createService } from '../src/service.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : join(ROOT, '.orca', 'shots')
const ONLY = process.argv.slice(3)
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// Orca's panel tokens (--orca-*), from its stylesheet.
const THEMES = {
  dark: { background: '#0a0a0a', foreground: '#f0f0f0', card: '#141414', popover: '#141414', 'muted-foreground': '#acacac', accent: '#262626', primary: '#e5e5e5', border: '#262626', input: '#333333', ring: '#737373', radius: '8px' },
  light: { background: '#ffffff', foreground: '#0a0a0a', card: '#ffffff', popover: '#ffffff', 'muted-foreground': '#696969', accent: '#f5f5f5', primary: '#171717', border: '#e5e5e5', input: '#e5e5e5', ring: '#a1a1a1', radius: '8px' }
}

const store = () => {
  const values = {}
  return { get: async (k) => values[k] ?? null, set: async (k, v) => void (values[k] = v), onDidChange: () => ({ dispose() {} }) }
}

async function sampleSnapshot() {
  const service = createService({ backends: { sample: createSampleBackend() }, taskSources: { sample: createSampleTasks() }, taskAccess: async () => 'write', settings: { ...store(), get: async (k) => ({ backend: 'sample', days: 3 })[k] }, storage: store() })
  return service.load()
}

const base = await sampleSnapshot()
const blocking = (status, backend, message) => ({ ...base, backend, status, message, events: [], calendars: [] })
const auth = { clientId: null, hasSecret: false, connected: false, platform: 'darwin', redirectUri: 'http://127.0.0.1:43119/callback', missingScopes: [] }

// name: [snapshot, auth.info, script run after the first render]
const STATES = {
  agenda: [base, auth, ''],
  details: [base, auth, `document.querySelector('[data-open="review"]').click()`],
  calendars: [base, auth, `document.getElementById('settings').click()`],
  rsvp: [base, auth, `document.querySelector('[data-open="customer"]').click()`],
  connect: [blocking('needs-setup', 'google', MESSAGES.needsSetup), auth, ''],
  'connect-ended': [blocking('unauthenticated', 'google', MESSAGES.unauthenticated), { ...auth, clientId: '1234567890-abcdefghijklmnop.apps.googleusercontent.com', hasSecret: true }, ''],
  'mac-access': [blocking('not-asked', 'eventkit', MESSAGES.notAsked), auth, ''],
  offline: [{ ...base, status: 'offline', message: MESSAGES.offline, stale: true }, auth, ''],
  task: [base, auth, `document.querySelector('[data-open="task:my-tasks/q4-report"]').click()`],
  'tasks-no-scope': [{ ...base, backend: 'google', tasks: [], taskLists: [], tasksStatus: 'no-scope' }, { ...auth, connected: true, tasks: 'none' }, `document.getElementById('settings').click()`],
  'tasks-api-off': [{ ...base, backend: 'google', tasks: [], taskLists: [], tasksStatus: 'api-disabled', tasksMessage: 'Enable the Google Tasks API in your Google Cloud project (APIs & Services → Library → Google Tasks API → Enable), wait a minute, then refresh.' }, { ...auth, connected: true, tasks: 'write' }, `document.getElementById('settings').click()`]
}

const harness = (theme, snapshot, info, script) => `<!doctype html><html class="${theme}"><head><meta charset="utf-8"><style>html{width:360px;max-width:360px}:root{${Object.entries(THEMES[theme])
  .map(([k, v]) => `--orca-${k}:${v}`)
  .join(';')}}</style>
<script>
window.orca = {
  locale: 'en-US',
  plugin: {
    request: async (name) => (name === 'auth.info' ? ${JSON.stringify(info)} : ${JSON.stringify(snapshot)}),
    on: () => {}
  },
  shell: { openExternal: async () => ({ opened: false }) },
  on: () => {}
}
setTimeout(() => { ${script} }, 400)
</script></head><body></body></html>`

const panel = readFileSync(join(ROOT, 'panel', 'index.html'), 'utf8')
const page = (theme, state) => {
  const [snapshot, info, script] = STATES[state]
  const head = harness(theme, snapshot, info, script)
  // The real panel, with the stand-in's head first.
  return panel.replace('<html>', '').replace('<!doctype html>', head.replace('</body></html>', ''))
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const [, theme, state] = url.pathname.match(/^\/shot\/(light|dark)\/([\w-]+)\/panel\/index\.html$/) ?? []
  if (theme) {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end(page(theme, state))
  }
  const rel = normalize(url.pathname.replace(/^\/shot\/(light|dark)\/[\w-]+\//, '/')).replace(/^\/+/, '')
  if (rel.startsWith('..') || !/^(shared|panel)\//.test(rel)) return res.writeHead(404).end()
  try {
    const body = readFileSync(join(ROOT, rel))
    res.writeHead(200, { 'content-type': extname(rel) === '.mjs' ? 'text/javascript' : 'text/plain' })
    res.end(body)
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
mkdirSync(OUT, { recursive: true })

const shots = []
for (const state of Object.keys(STATES)) {
  if (ONLY.length && !ONLY.includes(state)) continue
  for (const theme of ['light', 'dark']) {
    const out = join(OUT, `${state}-${theme}.png`)
    await promisify(execFile)(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', `--window-size=360,820`, '--virtual-time-budget=3000', `--screenshot=${out}`, `http://127.0.0.1:${port}/shot/${theme}/${state}/panel/index.html`], { timeout: 30_000 })
    shots.push(out)
  }
}
server.close()
console.log(shots.join('\n'))
