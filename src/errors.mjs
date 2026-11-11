// The error every backend throws, with a `kind` the panel turns into a state and a sentence it
// shows as is.

export const MESSAGES = Object.freeze({
  needsSetup: 'Connect your Google account to see your Google Calendar here.',
  unauthenticated: 'Your Google login ended. Connect again to keep seeing your calendar.',
  rateLimited: 'Google asked Calendar to slow down. It tries again in a minute.',
  offline: 'Can’t reach Google Calendar. Calendar shows what it last read and tries again shortly.',
  blocked: 'Your Google Workspace admin hasn’t allowed this app. Ask them to trust its client ID in the Admin console (Security → API controls).',
  macOnly: 'Mac calendars are only available on macOS. Connect Google Calendar instead.',
  noAccess: 'Orca isn’t allowed to read your calendars. Open System Settings → Privacy & Security → Calendars, turn on Orca, then refresh.',
  notAsked: 'Allow Orca to read the calendars on this Mac. macOS asks you once.',
  restricted: 'This Mac doesn’t allow apps to read calendars (a device policy). Connect Google Calendar instead.',
  timeout: 'The Mac’s calendar didn’t answer within 10 seconds.'
})

export class CalendarError extends Error {
  constructor(kind, message, extra) {
    super(message)
    this.kind = kind
    if (extra) Object.assign(this, extra)
  }
}

export const toCalendarError = (error) =>
  error instanceof CalendarError ? error : new CalendarError('error', `Calendar could not be read: ${String(error?.message ?? error).trim()}`)
