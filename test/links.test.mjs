import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findConference, joinKind } from '../shared/links.mjs'

test('recognizes Meet, Zoom, Teams and Slack huddle links', () => {
  assert.equal(joinKind('https://meet.google.com/abc-defg-hij'), 'meet')
  assert.equal(joinKind('https://meet.google.com/abc-defg-hij?authuser=1'), 'meet')
  assert.equal(joinKind('https://acme.zoom.us/j/81234567890?pwd=xyz'), 'zoom')
  assert.equal(joinKind('https://zoom.us/j/81234567890'), 'zoom')
  assert.equal(joinKind('https://us02web.zoom.us/my/sample.room'), 'zoom')
  assert.equal(joinKind('https://acme.zoomgov.com/j/1612345678'), 'zoom')
  assert.equal(joinKind('https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d'), 'teams')
  assert.equal(joinKind('https://teams.live.com/meet/9876543210'), 'teams')
  assert.equal(joinKind('https://app.slack.com/huddle/T01ABCDEF/C02GHIJKL'), 'slack')
  assert.equal(joinKind('https://acme.slack.com/huddle/T01ABCDEF/C02GHIJKL'), 'slack')
})

test('refuses look-alikes, plain http and other schemes', () => {
  assert.equal(joinKind('http://meet.google.com/abc-defg-hij'), null)
  assert.equal(joinKind('https://meet.google.com.evil.example/abc-defg-hij'), null)
  assert.equal(joinKind('https://evilzoom.us/j/123'), null)
  assert.equal(joinKind('https://zoom.us.evil.example/j/123'), null)
  assert.equal(joinKind('https://teams.microsoft.com/settings'), null)
  assert.equal(joinKind('javascript:alert(1)'), null)
  assert.equal(joinKind('https://user:pw@meet.google.com/abc-defg-hij'), null)
  assert.equal(joinKind(''), null)
  assert.equal(joinKind(undefined), null)
})

test('prefers Google conference data, then hangoutLink, then location, URL and notes', () => {
  const conferenceData = {
    conferenceSolution: { name: 'Zoom Meeting', key: { type: 'addOn' } },
    entryPoints: [
      { entryPointType: 'phone', uri: 'tel:+1-555-0100' },
      { entryPointType: 'video', uri: 'https://acme.zoom.us/j/81234567890' }
    ]
  }
  assert.deepEqual(findConference({ conferenceData, hangoutLink: 'https://meet.google.com/aaa-bbbb-ccc' }), {
    kind: 'zoom',
    url: 'https://acme.zoom.us/j/81234567890',
    label: 'Zoom'
  })
  assert.deepEqual(findConference({ hangoutLink: 'https://meet.google.com/aaa-bbbb-ccc', location: 'https://acme.zoom.us/j/1' }), {
    kind: 'meet',
    url: 'https://meet.google.com/aaa-bbbb-ccc',
    label: 'Google Meet'
  })
  assert.equal(findConference({ location: 'Room 4 / https://teams.microsoft.com/l/meetup-join/abc' }).kind, 'teams')
  assert.equal(findConference({ url: 'https://app.slack.com/huddle/T1/C2' }).kind, 'slack')
  const notes = 'Agenda\n<a href="https://meet.google.com/xyz-abcd-efg">Join</a>\nDial-in…'
  assert.equal(findConference({ description: notes }).url, 'https://meet.google.com/xyz-abcd-efg')
  assert.equal(findConference({ location: 'Room 4' }), null)
})

test('an unknown video entry point is kept as "other" when it is https', () => {
  const conferenceData = { conferenceSolution: { name: 'Webex' }, entryPoints: [{ entryPointType: 'video', uri: 'https://acme.example.com/meet/42' }] }
  assert.deepEqual(findConference({ conferenceData }), { kind: 'other', url: 'https://acme.example.com/meet/42', label: 'Webex' })
  const bad = { conferenceSolution: { name: 'X' }, entryPoints: [{ entryPointType: 'video', uri: 'http://acme.example.com/' }] }
  assert.equal(findConference({ conferenceData: bad }), null)
})

test('strips trailing punctuation that text around a link adds', () => {
  assert.equal(findConference({ description: 'Join at https://meet.google.com/abc-defg-hij.' }).url, 'https://meet.google.com/abc-defg-hij')
  assert.equal(findConference({ description: '(https://acme.zoom.us/j/123)' }).url, 'https://acme.zoom.us/j/123')
})
