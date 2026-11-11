# Calendar backends for an Orca plugin

Question: how should an Orca plugin read the user's meetings, and answer invitations, with the
least setup? The user lives in Google Calendar on a company Google Workspace account and works
on a Mac.

Checked on 2026-11-11 against Orca 1.4.256 on macOS 27.0.1.

## Recommendation

1. **Google Calendar API is the default backend.** It has everything the panel draws: Google's
   own calendar colours, conference links in `conferenceData`, the user's response on each event,
   recurring events expanded by the server (`singleEvents=true`), and the only way to accept or
   decline from Orca. It costs one setup: the user creates an OAuth client of type *Desktop app*
   in a Google Cloud project, and pastes its client ID and secret into the panel.
2. **The Mac's own calendar store (EventKit) is the zero-setup fallback.** It works from a process
   Orca spawns, through `osascript -l JavaScript`, with no compile step. It reads whatever accounts
   macOS has (Google, Exchange, iCloud), recurring events already expanded, in under 100 ms for a
   week. It cannot answer invitations and does not see Google's conference data except where the
   link is in the location, URL or notes.
3. **No iCal URL backend.** See [below](#secret-ical-address-not-built).

The `auto` backend setting uses Google once it is connected, and the Mac's calendars until then.

## Orca facts that shape the design

From `orca skills get orca-plugin-authoring` and its `host-api`, `manifest`, `recipes`
references (Orca 1.4.256, host API 1.5):

- A panel is a sandboxed frame with no network. The worker does every HTTP call and every
  `osascript` spawn. The panel reaches the worker with `orca.plugin.request(name, input)` and
  hears `orca.panels.post(event, payload)`.
- `statusBar.update({ id, text, icon, tone, tooltip, visible })` takes plain text; there is no
  relative-time field for status bar items. `tone` is `neutral | accent | success | warning |
  danger`. The live `{ type: 'relative', at }` cells and `<RelativeTime>` exist only in components
  panels, not in an HTML panel or the status bar. So the worker sets a timer for the next moment
  the text changes (the next whole minute while a meeting is near, or the next start or end), and
  never re-reads the calendar to do so. The HTML panel does the same for its "now" line.
- A plugin with `main` and a status bar item has its worker started on enable and kept running
  while it stays enabled, so the worker can refresh the agenda and fire notifications with the
  panel closed.
- `notifications.show({ title, body })` needs `notifications:show`.
- `shell.openExternal({ url })` is panel-only and needs a press on a settled control. Orca asks
  the person before opening an http(s) host the plugin was not allowed. The join button calls it.
- Settings the user edits: `contributes.settings`. Secrets: `orca.secrets` (OS keyring; on Linux
  without one `secrets.set` fails). Plugin ids starting `orca-` are reserved; leave out
  `publisher`; `statusBarItems` needs `engines.orca >=1.4.248`.

## Google Calendar API

### OAuth for an installed app

Source: [OAuth 2.0 for iOS & Desktop Apps](https://developers.google.com/identity/protocols/oauth2/native-app).

- Authorization endpoint `https://accounts.google.com/o/oauth2/v2/auth`, token endpoint
  `https://oauth2.googleapis.com/token`, revocation `https://oauth2.googleapis.com/revoke`.
- Redirect: loopback, `http://127.0.0.1:<port>`. Desktop-app clients accept any port on the
  loopback address, so nothing is registered in the console. Custom schemes and copy/paste (OOB)
  are gone.
- PKCE: "Always use PKCE"; S256.
- "Refresh tokens are always returned for installed applications." The plugin still sends
  `access_type=offline` and `prompt=consent` so a reconnect after a scope change gets a new one.
- **The client secret.** The doc lists `client_secret` as optional and calls desktop apps public
  clients, but Google's token endpoint still refuses a code exchange and refresh without it for
  *Desktop app* clients (widely reported:
  [Google developer forum thread](https://discuss.google.dev/t/desktop-oauth-pkce-exchange-returns-invalid-request-after-successful-loopback-callback-with-no-client-secret/390526),
  [another](https://discuss.google.dev/t/google-auth-platform-question-about-desktop-app-client-and-secret/178938)).
  Google's own client libraries send it. The plugin asks for both and keeps the secret in
  `orca.secrets`, never in a setting. For a desktop client it is not a real secret; PKCE is what
  protects the code.

### Scopes

Source: [Choose Google Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth).

| Need | Narrowest scope |
| --- | --- |
| Calendar list with colours | `calendar.calendarlist.readonly` |
| Read events on every calendar, invitations included | `calendar.events.readonly` |
| Change the user's own response | `calendar.events` (there is no RSVP-only scope; `calendar.events.owned` misses invitations on other people's calendars) |

The plugin asks for `calendar.calendarlist.readonly` + `calendar.events.readonly` while the
**Answer invitations** setting is off, and swaps `calendar.events.readonly` for `calendar.events`
when it is on (default on). Changing the setting asks the user to reconnect. All of these are
*sensitive* scopes, not *restricted* ones, so a personal-use client never needs Google's
security assessment.

### Reading the agenda

Sources: [events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list),
[Events resource](https://developers.google.com/workspace/calendar/api/v3/reference/events),
[calendarList](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList).

- `GET /calendar/v3/users/me/calendarList`: `id`, `summary` (and `summaryOverride`),
  `backgroundColor`/`foregroundColor` (the user's own colour for that calendar), `primary`,
  `selected` (shown in Google's UI), `accessRole`, `timeZone`. The primary calendar's id is the
  user's email.
- `GET /calendar/v3/calendars/{id}/events?singleEvents=true&orderBy=startTime&timeMin=…&timeMax=…`
  per shown calendar. `singleEvents=true` expands recurring events into instances, and
  `orderBy=startTime` needs it. `timeMin` bounds the event's *end*, `timeMax` its *start*, both
  RFC 3339 with an offset. Default 250 per page, max 2500; follow `nextPageToken`.
- `start`/`end`: `date` (all-day, end exclusive) or `dateTime` with an offset plus an IANA
  `timeZone`. The plugin turns `dateTime` into epoch ms and keeps all-day dates as `yyyy-mm-dd`,
  so time zones are only applied once, in the panel, in Orca's own zone.
- `status`: `confirmed | tentative | cancelled`. `list` leaves cancelled ones out unless
  `showDeleted`.
- Conference: `conferenceData.entryPoints[]` with `entryPointType` `video | phone | sip | more`
  and `uri`; `conferenceData.conferenceSolution.name`/`key.type` (`hangoutsMeet`, or an add-on
  like Zoom). Older events carry only `hangoutLink`.
- People: `attendees[]` with `email`, `displayName`, `self`, `organizer`, `optional`, `resource`
  (rooms), `responseStatus` `needsAction | declined | tentative | accepted`. `attendeesOmitted`
  says the list is partial.
- `eventType`: `default | focusTime | outOfOffice | workingLocation | birthday | fromGmail`.
  Working-location events are hidden from the agenda; focus time and out-of-office are shown.
- `colorId` points to Google's fixed event palette (11 colours from `colors.get`); the plugin
  ships the table instead of spending a call.
- `transparency: transparent` ("Free") events do not block the free-gap calculation.

### Answering an invitation

`PATCH` replaces arrays: "Array fields, if specified, overwrite the existing arrays". The
Events resource says `attendeesOmitted` "can be used to only update the participant's response".
So the plugin sends

```http
PATCH /calendar/v3/calendars/{calendarId}/events/{eventId}?sendUpdates=all
{ "attendeesOmitted": true, "attendees": [{ "email": "<self>", "responseStatus": "accepted" }] }
```

on the instance's own id, which answers that one occurrence. The plugin only does this when the
user presses Accept, Maybe or Decline in the finished panel; tests run it against a fake API.

### Setup on a company Google Workspace account

Sources: [Manage app audience](https://support.google.com/cloud/answer/15549945),
[Control which apps access Google Workspace data](https://knowledge.workspace.google.com/admin/apps/control-which-apps-access-google-workspace-data).

- **User type Internal** is available when the Cloud project belongs to the company's
  organization. Only members of the organization can sign in, there is no test-user list, no
  verification, and refresh tokens do not expire after 7 days. This is the one to pick.
- **User type External, publishing status Testing** works with any account but "authorizations by
  a test user will expire seven days from the time of consent": the user would reconnect weekly.
  The user must add themselves as a test user. Publishing to production without verification
  shows the unverified-app warning; that works for one person, but is the second choice.
- **Admin restrictions are per service, not per scope.** In the Admin console (Security → Access
  and data control → API controls) an admin may block unconfigured third-party apps, or mark
  Google Calendar as *Restricted*, which admits only apps marked Trusted. Read-only scopes do not
  get around either. "Trust internal apps" lets apps owned by the organization through; an
  Internal client in a company project counts as one. If the user can't create a project in the
  company organization, or sees "Access blocked: … has not been approved by your admin", only an
  admin can help: they trust the client ID in API controls.
- A personal Gmail account cannot pick Internal; it uses External + Testing (or publishes
  unverified).

The exact click path is in the README and the panel's connect screen.

### Quotas

The Calendar API's default per-user quota is far above what one agenda needs. The plugin reads
the calendar list once per refresh and each shown calendar's window of days, every 5 minutes
while enabled and whenever the panel opens or the user presses refresh.

## Mac calendars through EventKit

Tested from an Orca terminal, the same process tree a plugin worker's children have (Orca is the
responsible app for TCC):

- `osascript -l JavaScript` with `ObjC.import('EventKit')` loads the framework; no Xcode, no
  compile step. `swift` exists here but only with the Command Line Tools, which users may lack.
- `EKEventStore.authorizationStatusForEntityType(EKEntityTypeEvent)` answers without a prompt:
  `0` not determined, `1` restricted, `2` denied, `3` full access, `4` write only.
- `requestFullAccessToEventsWithCompletion` (macOS 14+) showed Orca's
  `NSCalendarsFullAccessUsageDescription` prompt on the user's screen once and was granted; the
  status became `3`. The JXA completion block did not fire within the run loop wait, so the
  plugin polls the authorization status instead of waiting on the callback. If nobody answers,
  it stops after a minute and the panel keeps its "Allow access" button; it never loops.
- `eventsMatchingPredicate(predicateForEventsWithStartDateEndDateCalendars(...))` returns each
  occurrence of recurring events, already expanded, with `allDay`, `startDate`, `endDate`,
  `timeZone`, `location`, `URL`, `notes`, `attendees` (`EKParticipant`: `name`, `URL` mailto,
  `participantStatus`, `isCurrentUser`), `organizer`, `status`, `availability`, and
  `calendar` (`title`, `color`, `calendarIdentifier`, `source.title`). A week across 27
  calendars read in 94 ms.
- EventKit's `EKParticipant` is read-only: no answering invitations. Calendar.app's AppleScript
  dictionary does not expand recurring events, so it is not used.
- Off macOS this backend reports "unsupported".

## Secret iCal address (not built)

Google offers a "Secret address in iCal format" per calendar. It needs no OAuth, but:

- Workspace admins can turn it off for the organization, and many do; it is off by default in
  some editions.
- The plugin would expand `RRULE`/`EXDATE`/`RDATE` and recurrence overrides (`RECURRENCE-ID`)
  itself, with VTIMEZONE handling, in plain `.mjs` without dependencies. That is the most
  error-prone part of any calendar client.
- It is read-only, has no response status for invitations in a reliable form, one URL per
  calendar, and Google refreshes it with a delay of hours.
- Anyone holding the URL reads the calendar.

EventKit already covers "zero setup" on a Mac with none of these costs, so the iCal backend is
left out.
