// The plugin page images: present, the sizes Orca accepts, and described.
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { test } from 'node:test'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('orca-plugin.json', root), 'utf8'))

// Width and height from a PNG's IHDR chunk.
function pngSize(path) {
  const bytes = readFileSync(new URL(path, root))
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG', `${path} is a PNG`)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), kb: statSync(new URL(path, root)).size / 1024 }
}

test('icon: a square PNG of at least 128 px, at most 256 KB', () => {
  const { width, height, kb } = pngSize(manifest.icon)
  assert.equal(width, height)
  assert.ok(width >= 128)
  assert.ok(kb <= 256)
})

test('cover: 16:10, at least 800×500, at most 1024 KB, with alt text', () => {
  const { width, height, kb } = pngSize(manifest.cover.path)
  assert.equal(width / height, 1.6)
  assert.ok(width >= 800 && height >= 500)
  assert.ok(kb <= 1024)
  assert.ok(manifest.cover.alt.length > 40 && manifest.cover.alt.length <= 160)
})

test('screenshots: 3 to 6, at least 1280×800, at most 1536 KB each and 8 MB in all, each captioned', () => {
  const shots = manifest.screenshots
  assert.ok(shots.length >= 3 && shots.length <= 6)
  let total = pngSize(manifest.cover.path).kb + pngSize(manifest.icon).kb
  for (const shot of shots) {
    const { width, height, kb } = pngSize(shot.path)
    assert.ok(width >= 1280 && height >= 800, shot.path)
    assert.ok(kb <= 1536, shot.path)
    assert.ok(shot.alt.length > 40 && shot.alt.length <= 160, shot.path)
    assert.ok(shot.caption, shot.path)
    total += kb
  }
  assert.ok(total <= 8 * 1024)
})

test('the README shows the same images', () => {
  const readme = readFileSync(new URL('README.md', root), 'utf8')
  for (const path of [manifest.cover.path, ...manifest.screenshots.map((s) => s.path)]) assert.ok(readme.includes(path), path)
  for (const [, path] of readme.matchAll(/\]\((images\/[^)]+)\)/g)) statSync(new URL(path, root))
})
