// Renders the plugin page images into images/: the cover, the screenshots and the icon. Each
// scene is HTML around the real panel/index.html, loaded in iframes from a local server, with a
// stand-in window.orca answering from the sample week. The clock in every panel is frozen at
// 10:36 on the sample's Wednesday, so the images come out the same each run. The status bar
// text and the reminder are what src/status-bar.mjs and src/reminders.mjs produce for that week.
// Made-up data only: no real events, people or addresses, and no service logos.
//
//   node scripts/render-listing-images.mjs            # all of them
//   node scripts/render-listing-images.mjs cover      # one
//
// The plugin list shows the cover as a small card cropped to about 1.9:1 around its middle, so
// what matters sits inside the middle 840 px of height and reads at 500 px wide.
//
// Needs Google Chrome (or set CHROME to a Chrome or Chromium binary).
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createSampleBackend } from '../backends/sample.mjs'
import { formatDuration, formatRange, where } from '../shared/format.mjs'
import { MESSAGES } from '../src/errors.mjs'
import { createService } from '../src/service.mjs'
import { statusBarView } from '../src/status-bar.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'images')
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const WIDTH = 1600
const HEIGHT = 1000

// Orca's panel tokens (--orca-*), from its stylesheet.
const THEMES = {
  dark: { background: '#0a0a0a', foreground: '#f0f0f0', card: '#141414', popover: '#141414', 'muted-foreground': '#acacac', accent: '#262626', primary: '#e5e5e5', border: '#262626', input: '#333333', ring: '#737373', radius: '8px' },
  light: { background: '#ffffff', foreground: '#0a0a0a', card: '#ffffff', popover: '#ffffff', 'muted-foreground': '#696969', accent: '#f5f5f5', primary: '#171717', border: '#e5e5e5', input: '#e5e5e5', ring: '#a1a1a1', radius: '8px' }
}

// ---------- the sample week at a fixed time ----------

const base = new Date()
const at = (h, m) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m).getTime()
// The sample anchors today's meetings to the quarter hour of "now": at 10:00 the design review
// runs 9:45–10:30 and the customer call starts at 10:40.
const ANCHOR = at(10, 0)

async function snapshotAt() {
  const store = () => {
    const values = {}
    return { get: async (k) => values[k] ?? null, set: async (k, v) => void (values[k] = v), onDidChange: () => ({ dispose() {} }) }
  }
  const service = createService({
    backends: { sample: createSampleBackend({ now: () => ANCHOR }) },
    settings: { ...store(), get: async (k) => ({ backend: 'sample', days: 3 })[k] },
    storage: store(),
    now: () => ANCHOR
  })
  return service.load()
}

const week = await snapshotAt()
// The listing shows "your" calendar, not the sample: the same events without the sample card.
const mine = { ...week, backend: 'google', calendars: week.calendars.map((c) => ({ ...c, account: 'Google' })) }
const auth = { clientId: null, hasSecret: false, connected: false, platform: 'darwin', redirectUri: 'http://127.0.0.1:43119/callback', missingScopes: [], rsvp: true }
const connected = { ...auth, clientId: '1234567890-abcdefghijklmnop.apps.googleusercontent.com', hasSecret: true, connected: true }
const blocking = (status, backend, message) => ({ ...week, backend, status, message, events: [], calendars: [] })

const event = (id) => week.events.find((e) => e.id === id)
const fmt = { locale: 'en-US' }
const bar = (h, m) => statusBarView(week.events, at(h, m), fmt)

// A panel: which snapshot it answers with, the time on its clock, and presses once it has drawn.
const PANELS = {
  agenda: { snap: mine, auth: connected, time: [10, 12] },
  soon: { snap: mine, auth: connected, time: [10, 36] },
  details: { snap: mine, auth: connected, time: [10, 12], steps: `press('[data-open="review"]')` },
  invite: { snap: mine, auth: connected, time: [10, 36], steps: `press('[data-open="customer"]')` },
  calendars: { snap: mine, auth: connected, time: [10, 36], steps: `press('#settings')` },
  connect: { snap: blocking('needs-setup', 'google', MESSAGES.needsSetup), auth, time: [10, 36] },
  sample: { snap: week, auth, time: [10, 36] }
}

function panelPage(name, theme) {
  const { snap, auth: info, time, steps = '' } = PANELS[name]
  const fixed = at(...time)
  const tokens = Object.entries(THEMES[theme]).map(([k, v]) => `--orca-${k}:${v}`).join(';')
  const stub = `<style>:root{${tokens}} html,body{scrollbar-width:none} ::-webkit-scrollbar{display:none}</style>
<script>
(() => {
  const FIXED = ${fixed}
  const Real = Date
  class Frozen extends Real {
    constructor(...args) { super(...(args.length ? args : [FIXED])) }
    static now() { return FIXED }
  }
  window.Date = Frozen
  const snap = ${JSON.stringify(snap)}
  const info = ${JSON.stringify(info)}
  window.orca = {
    locale: 'en-US',
    plugin: { request: async (name) => JSON.parse(JSON.stringify(name === 'auth.info' ? info : snap)), on: () => ({ dispose() {} }) },
    shell: { openExternal: async () => ({ opened: false }) },
    on: () => ({ dispose() {} })
  }
  window.press = (selector) => document.querySelector(selector)?.click()
  window.addEventListener('load', () => setTimeout(() => { ${steps} }, 250))
})()
</script>`
  const panel = readFileSync(join(ROOT, 'panel', 'index.html'), 'utf8')
  return panel.replace('<html>', `<html class="${theme}">`).replace('<head>', '<head>' + stub)
}

// ---------- scene pieces ----------

const frame = (name, theme, { width = 360, height = 720, zoom = 1, style = '' } = {}) =>
  `<div class="frame" style="width:${width * zoom}px;height:${height * zoom}px;background:${THEMES[theme].background};${style}">
    <iframe src="/panel/${name}/${theme}/panel/index.html" style="width:${width}px;height:${height}px;zoom:${zoom}"></iframe>
  </div>`

const CAL_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/></svg>`
const TONE = { neutral: '#c8c8c8', warning: '#f5b84a', accent: '#8ab4f8' }

// One of Orca's status bar items, drawn as Orca draws them: icon and text in the item's tone.
const statusItem = (view, { scale = 1 } = {}) =>
  `<span class="sb-item" style="color:${TONE[view.tone]};font-size:${12.5 * scale}px;gap:${6 * scale}px">${CAL_ICON.replace(/14/g, String(Math.round(14 * scale)))}${view.text}</span>`

// A status bar strip: Orca's other items as quiet placeholders, ours at the right.
const statusBar = (view, { width = 900, scale = 1, style = '' } = {}) =>
  `<div class="sb" style="width:${width}px;height:${30 * scale}px;padding:0 ${14 * scale}px;${style}">
    <span class="sb-ghost" style="width:${70 * scale}px"></span><span class="sb-ghost" style="width:${46 * scale}px"></span>
    <span style="flex:1"></span>${statusItem(view, { scale })}<span class="sb-ghost" style="width:${40 * scale}px"></span>
  </div>`

// A desktop notification, as the reminder shows it (title and body from src/reminders.mjs).
function notification(id, minutes, { style = '' } = {}) {
  const e = event(id)
  const title = `${e.title} in ${formatDuration(minutes * 60_000)}`
  const body = [formatRange(e.start, e.end, fmt), where(e)].filter(Boolean).join(' · ')
  return `<div class="note" style="${style}">
    <div class="note-app"><i></i>Calendar<span>now</span></div>
    <div class="note-title">${title}</div><div class="note-body">${body}</div>
  </div>`
}

// Orca's window around the panel: a workspace list, an editor and terminal, the sidebar, the
// status bar. Everything but the panel and our item is drawn as quiet shapes.
function orcaWindow({ panel, status, width = 980, height = 800, sideWidth = 360, style = '' }) {
  const lines = [64, 82, 40, 70, 55, 90, 30, 76, 48, 66, 58, 84, 36, 72].map((w, i) => `<i style="width:${w}%;opacity:${0.35 + (i % 3) * 0.12};margin-left:${(i % 4) * 14}px"></i>`)
  return `<div class="win" style="width:${width}px;height:${height}px;${style}">
    <div class="win-bar"><b></b><b></b><b></b></div>
    <div class="win-body">
      <div class="rail">${Array.from({ length: 7 }, (_, i) => `<span style="width:${[70, 54, 62, 48, 66, 40, 58][i]}%;${i === 1 ? 'background:#2a2f3a' : ''}"></span>`).join('')}</div>
      <div class="editor"><div class="tabs"><span></span><span></span></div><div class="code">${lines.join('')}</div><div class="term">${lines.slice(0, 6).join('')}</div></div>
      <div class="side" style="width:${sideWidth}px">${panel}</div>
    </div>
    <div class="win-status">${status}</div>
  </div>`
}

function page(body, { theme = 'dark', glow = '#1a73e8', glow2 = '#ea4335' } = {}) {
  const t = THEMES[theme]
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
    body {
      position: relative; background: ${t.background}; color: ${t.foreground};
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
      background-image: radial-gradient(900px 600px at 82% 18%, ${glow}${theme === 'dark' ? '33' : '22'}, transparent 70%),
                        radial-gradient(700px 500px at 8% 100%, ${glow2}${theme === 'dark' ? '22' : '16'}, transparent 70%);
    }
    .frame { border-radius: 16px; overflow: hidden; flex: none; border: 1px solid ${theme === 'dark' ? '#262626' : '#e3e3e3'};
      box-shadow: 0 40px 90px -30px rgba(0,0,0,${theme === 'dark' ? 0.9 : 0.35}), 0 2px 8px rgba(0,0,0,0.12); }
    .frame iframe { border: 0; display: block; }
    .eyebrow { font-size: 15px; font-weight: 650; letter-spacing: 0.16em; text-transform: uppercase; color: ${t['muted-foreground']}; }
    h1 { font-size: 128px; line-height: 0.92; letter-spacing: -0.05em; margin: 16px 0 26px; font-weight: 760; }
    h2 { font-size: 50px; line-height: 1.06; letter-spacing: -0.03em; margin: 14px 0 20px; font-weight: 720; }
    p.lead { font-size: 27px; line-height: 1.38; color: ${t['muted-foreground']}; margin: 0; }
    .chips { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 34px; }
    .chips span { font-size: 19px; font-weight: 560; padding: 10px 18px; border-radius: 999px;
      background: ${theme === 'dark' ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)'}; border: 1px solid ${theme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'}; }
    .chips span i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 9px; transform: translateY(-1px); }
    .caption { font-size: 17px; font-weight: 600; color: ${t['muted-foreground']}; text-align: center; margin-top: 16px; }
    .fine { position: absolute; left: 96px; bottom: 44px; font-size: 14px; color: ${t['muted-foreground']}; opacity: 0.75; }

    .sb { display: flex; align-items: center; gap: 14px; background: #101114; border-top: 1px solid #22242a; box-sizing: border-box; border-radius: 0 0 12px 12px; }
    .sb-ghost { height: 7px; border-radius: 4px; background: #2c2f36; }
    .sb-item { display: inline-flex; align-items: center; white-space: nowrap; font-weight: 500; }
    .sb-item svg { flex: none; }
    .pill { display: inline-flex; align-items: center; gap: 12px; padding: 14px 22px; border-radius: 14px; background: #101114; border: 1px solid #2a2d34;
      box-shadow: 0 24px 50px -20px rgba(0,0,0,0.9); }

    .note { width: 380px; padding: 14px 16px; border-radius: 16px; background: ${theme === 'dark' ? 'rgba(44,46,52,0.92)' : 'rgba(246,246,248,0.96)'};
      color: ${t.foreground}; box-shadow: 0 30px 60px -24px rgba(0,0,0,0.7), 0 0 0 1px rgba(127,127,127,0.18); font-size: 14.5px; }
    .note-app { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 600; color: ${t['muted-foreground']}; margin-bottom: 6px; }
    .note-app i { width: 18px; height: 18px; border-radius: 5px; background: linear-gradient(160deg, #4f8ff7, #1a73e8); }
    .note-app span { margin-left: auto; font-weight: 500; }
    .note-title { font-weight: 650; margin-bottom: 2px; }
    .note-body { color: ${t['muted-foreground']}; }

    .win { position: absolute; border-radius: 14px; overflow: hidden; background: #0d0e11; border: 1px solid #23252b;
      box-shadow: 0 60px 120px -40px rgba(0,0,0,0.95); display: flex; flex-direction: column; }
    .win-bar { height: 34px; display: flex; align-items: center; gap: 8px; padding: 0 14px; background: #121317; border-bottom: 1px solid #1f2126; flex: none; }
    .win-bar b { width: 12px; height: 12px; border-radius: 50%; background: #2e3036; }
    .win-body { flex: 1; display: flex; min-height: 0; }
    .rail { width: 100px; padding: 18px 14px; display: grid; align-content: start; gap: 14px; background: #0f1013; border-right: 1px solid #1d1f24; flex: none; }
    .rail span { height: 9px; border-radius: 5px; background: #1f2229; padding: 6px 0; background-clip: content-box; }
    .editor { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .tabs { height: 34px; display: flex; gap: 8px; padding: 8px 12px 0; border-bottom: 1px solid #1d1f24; }
    .tabs span { width: 110px; border-radius: 6px 6px 0 0; background: #16181d; }
    .tabs span + span { background: transparent; border: 1px solid #1d1f24; border-bottom: 0; }
    .code, .term { display: grid; align-content: start; gap: 12px; padding: 20px 22px; }
    .code { flex: 1; }
    .term { height: 190px; border-top: 1px solid #1d1f24; background: #0b0c0f; }
    .code i, .term i { height: 8px; border-radius: 4px; background: #3a4150; display: block; }
    .term i { background: #2f4a3a; }
    .side { width: 360px; flex: none; border-left: 1px solid #1d1f24; overflow: hidden; }
    .side .frame { border: 0; border-radius: 0; box-shadow: none; }
    .win-status { flex: none; }
    .win-status .sb { border-radius: 0; }
    .callout { position: absolute; }
  </style></head><body>${body}</body></html>`
}

// ---------- scenes ----------

const soon = bar(10, 36)

const SCENES = {
  cover: () =>
    page(`
    <div style="position:absolute;left:96px;top:150px;width:520px">
      <div class="eyebrow">Orca plugin</div>
      <h1>Calendar</h1>
      <p class="lead">Your meetings in Orca's sidebar. The next one counts down in the status bar, and Join opens the call.</p>
      <div class="chips">
        <span><i style="background:#1a73e8"></i>Google Calendar</span>
        <span><i style="background:#33b679"></i>Mac calendars</span>
        <span><i style="background:#f4511e"></i>Meet · Zoom · Teams · Slack</span>
      </div>
    </div>
    ${orcaWindow({ panel: frame('soon', 'dark', { height: 586, zoom: 1.25 }), status: statusBar(soon, { width: 900 }), width: 900, height: 800, sideWidth: 450, style: 'left:660px;top:100px' })}
    <div class="callout pill" style="left:610px;top:772px">${statusItem(soon, { scale: 1.6 })}</div>
    <div class="fine">Made-up sample data. Not affiliated with Google or Apple.</div>`),

  agenda: () =>
    page(`
    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:56px">
      <div style="max-width:440px">
        <div class="eyebrow">Agenda</div>
        <h2>Today and the next days, at a glance.</h2>
        <p class="lead">Your calendar colours, all-day events on top, a red line at the current time, the meeting that's running, and the free time in between. Click one for the details.</p>
      </div>
      <div>${frame('agenda', 'dark', { height: 720, zoom: 1.08 })}<div class="caption">Dark</div></div>
      <div>${frame('details', 'light', { height: 720, zoom: 1.08 })}<div class="caption">Light, with an event open</div></div>
    </div>`),

  reminders: () =>
    page(`
    <div style="position:absolute;left:110px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;width:560px">
      <div class="eyebrow">Never miss the start</div>
      <h2>A countdown in the status bar, a reminder, and Join.</h2>
      <p class="lead">The status bar names your next meeting from an hour before, turns amber inside five minutes and says "now" while it runs. A notification comes a few minutes before; you choose how many.</p>
      <div style="display:grid;gap:14px;margin-top:40px">
        ${statusBar(bar(10, 31), { width: 520, scale: 1.25, style: 'border-radius:12px' })}
        ${statusBar(soon, { width: 520, scale: 1.25, style: 'border-radius:12px' })}
        ${statusBar(bar(10, 41), { width: 520, scale: 1.25, style: 'border-radius:12px' })}
      </div>
    </div>
    ${notification('customer', 5, { style: 'position:absolute;left:660px;top:110px' })}
    <div style="position:absolute;left:1080px;top:150px">${frame('soon', 'light', { height: 740, zoom: 1.0 })}</div>`,
      { glow: '#f5b84a', glow2: '#1a73e8' }),

  invitations: () =>
    page(`
    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:56px">
      <div style="max-width:420px">
        <div class="eyebrow">Invitations and calendars</div>
        <h2>Answer from Orca. Show only what matters.</h2>
        <p class="lead">Yes, No or Maybe on a Google Calendar invitation, with every guest's answer. Pick which calendars the agenda shows.</p>
      </div>
      <div>${frame('invite', 'light', { height: 720, zoom: 1.08 })}<div class="caption">Going? Yes, No, Maybe</div></div>
      <div>${frame('calendars', 'dark', { height: 720, zoom: 1.08 })}<div class="caption">Calendars and source</div></div>
    </div>`, { theme: 'light' }),

  setup: () =>
    page(`
    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:56px">
      <div style="max-width:420px">
        <div class="eyebrow">Setup</div>
        <h2>Google Calendar in five minutes. Your Mac's calendars in none.</h2>
        <p class="lead">Connect walks you through creating your own Google sign-in, once. On a Mac, the calendars you already have work with one click, and a sample week lets you look around first.</p>
      </div>
      <div>${frame('connect', 'light', { height: 830 })}<div class="caption">Connect Google Calendar</div></div>
      <div>${frame('sample', 'dark', { height: 830 })}<div class="caption">The sample week</div></div>
    </div>`, { theme: 'light', glow: '#33b679' })
}

// The icon: a calendar page with a now line and coloured events, drawn here. Not Google's logo.
const ICON = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:512px;height:512px;background:transparent}</style></head><body>
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d2230"/><stop offset="1" stop-color="#0c0e13"/></linearGradient>
    <linearGradient id="head" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5a9bff"/><stop offset="1" stop-color="#1a73e8"/></linearGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#bg)"/>
  <rect x="96" y="104" width="320" height="312" rx="40" fill="#f4f6fa"/>
  <path d="M96 144a40 40 0 0 1 40-40h240a40 40 0 0 1 40 40v28H96z" fill="url(#head)"/>
  <rect x="160" y="80" width="22" height="56" rx="11" fill="#e8ecf4"/>
  <rect x="330" y="80" width="22" height="56" rx="11" fill="#e8ecf4"/>
  <rect x="132" y="204" width="168" height="34" rx="10" fill="#33b679"/>
  <rect x="132" y="252" width="236" height="34" rx="10" fill="#1a73e8"/>
  <rect x="132" y="348" width="128" height="34" rx="10" fill="#f4511e"/>
  <circle cx="132" cy="315" r="12" fill="#ea4335"/>
  <rect x="132" y="311" width="252" height="8" rx="4" fill="#ea4335"/>
</svg></body></html>`

// ---------- render ----------

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  const scene = path.match(/^\/scene\/([\w-]+)\.html$/)
  if (scene && (SCENES[scene[1]] || scene[1] === 'icon')) {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end(scene[1] === 'icon' ? ICON : SCENES[scene[1]]())
  }
  const panel = path.match(/^\/panel\/([\w-]+)\/(light|dark)\/panel\/index\.html$/)
  if (panel && PANELS[panel[1]]) {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end(panelPage(panel[1], panel[2]))
  }
  // The panel's own modules, relative to its page.
  const rel = normalize(path.replace(/^\/panel\/[\w-]+\/(light|dark)\//, '/')).replace(/^\/+/, '')
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
const port = server.address().port
mkdirSync(OUT, { recursive: true })

const only = process.argv.slice(2)
try {
  for (const name of [...Object.keys(SCENES), 'icon']) {
    if (only.length && !only.includes(name)) continue
    const target = join(OUT, `${name}.png`)
    const size = name === 'icon' ? [512, 512] : [WIDTH, HEIGHT]
    await promisify(execFile)(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--virtual-time-budget=5000',
        ...(name === 'icon' ? ['--default-background-color=00000000'] : []),
        `--window-size=${size[0]},${size[1]}`,
        `--screenshot=${target}`,
        `http://127.0.0.1:${port}/scene/${name}.html`
      ],
      { timeout: 60_000 }
    )
    console.log(`${target} (${Math.round(statSync(target).size / 1024)} KB)`)
  }
} finally {
  server.close()
}
