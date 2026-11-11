// Runs the real panel/index.html in headless Chrome against a stand-in `orca`, plays a script of
// presses and keystrokes, and returns what the script reports: the requests the panel sent and
// whatever it read from the page. No dependencies: Chrome's --dump-dom carries the result back.
//
//   const out = await runPanel({ responses: { 'agenda.get': snapshot }, script: `...; done({...})` })
//
// In the script: `wait(ms)`, `type(id, text)`, `press(selector)`, `post(event)` (a worker post),
// `theme()` (Orca's theme event), `calls` (every request: { name, input }), `done(value)`.
// Set PANEL_HTML to run another copy of the panel (to check a test fails on old code).
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export const hasChrome = existsSync(CHROME)

const harness = (responses, script) => `<!doctype html><html class="light"><head><meta charset="utf-8">
<style>html{width:360px}</style>
<script>
const responses = ${JSON.stringify(responses)}
const calls = []
const listeners = {}
const themeListeners = []
window.orca = {
  locale: 'en-US',
  plugin: {
    request: async (name, input) => {
      calls.push({ name, input: input === undefined ? null : input })
      const answer = responses[name]
      if (answer && answer.__throw) throw Object.assign(new Error(answer.__throw), { code: 'invalid' })
      return answer === undefined ? null : JSON.parse(JSON.stringify(answer))
    },
    on: (event, fn) => ((listeners[event] ??= []).push(fn), { dispose() {} })
  },
  shell: { openExternal: async (url) => (calls.push({ name: 'shell.openExternal', input: url }), { opened: false }) },
  on: (event, fn) => (event === 'theme' && themeListeners.push(fn), { dispose() {} })
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const type = (id, text) => {
  const field = document.getElementById(id)
  field.focus()
  field.value += text
  field.dispatchEvent(new Event('input', { bubbles: true }))
}
const press = (selector) => document.querySelector(selector).click()
const post = (event) => (listeners[event] || []).forEach((fn) => fn({}))
const theme = () => themeListeners.forEach((fn) => fn({}))
const done = (value) => {
  const pre = document.createElement('pre')
  pre.id = '__result'
  pre.textContent = JSON.stringify(value)
  document.documentElement.appendChild(pre)
}
window.addEventListener('load', () => setTimeout(async () => {
  try { ${script} } catch (error) { done({ error: String(error && error.stack || error) }) }
}, 300))
</script></head><body></body></html>`

export async function runPanel({ responses, script, panel = process.env.PANEL_HTML || join(ROOT, 'panel', 'index.html') }) {
  const html = readFileSync(panel, 'utf8')
  const page = html.replace('<html>', '').replace('<!doctype html>', harness(responses, script).replace('</body></html>', ''))
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    if (path === '/panel/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end(page)
    }
    const rel = normalize(path).replace(/^\/+/, '')
    if (rel.startsWith('..') || !/^(shared|panel)\/[\w.-]+\.mjs$/.test(rel)) return res.writeHead(404).end()
    try {
      const body = readFileSync(join(ROOT, rel))
      res.writeHead(200, { 'content-type': extname(rel) === '.mjs' ? 'text/javascript' : 'text/plain' })
      res.end(body)
    } catch {
      res.writeHead(404).end()
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const { stdout } = await promisify(execFile)(
      CHROME,
      ['--headless=new', '--disable-gpu', '--no-first-run', '--virtual-time-budget=10000', '--dump-dom', `http://127.0.0.1:${server.address().port}/panel/index.html`],
      { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }
    )
    const match = stdout.match(/<pre id="__result">([\s\S]*?)<\/pre>/)
    if (!match) throw new Error('The panel script never called done()')
    const text = match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    const result = JSON.parse(text)
    if (result?.error) throw new Error(`In the panel: ${result.error}`)
    return result
  } finally {
    server.close()
  }
}
