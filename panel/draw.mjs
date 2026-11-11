// Draws a screen into `root` without losing what the person is doing in it. The panel redraws
// whenever the worker posts a new agenda, the theme changes or a request answers, and a redraw
// rebuilds every element: a field someone is typing in would lose its text, its focus and its
// caret, and an open <details> would close. So, for elements with an id:
//   - text fields keep what was typed (a non-empty value wins over the drawn one),
//   - the focused field keeps focus and its selection,
//   - <details> keep their open or closed state.
// Code that needs a field's value reads it before anything draws (see startLogin).

const TEXT = 'input[id]:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea[id]'

export function draw(root, html) {
  const doc = root.ownerDocument
  const typed = new Map()
  for (const field of root.querySelectorAll(TEXT)) if (field.value) typed.set(field.id, field.value)
  const opened = new Map()
  for (const details of root.querySelectorAll('details[id]')) opened.set(details.id, details.open)
  const active = doc.activeElement && root.contains(doc.activeElement) && doc.activeElement.id ? doc.activeElement : null
  const focus = active ? { id: active.id, start: selection(active, 'selectionStart'), end: selection(active, 'selectionEnd') } : null

  root.innerHTML = html

  for (const [id, value] of typed) {
    const field = doc.getElementById(id)
    if (field && root.contains(field) && field.matches(TEXT)) field.value = value
  }
  for (const [id, open] of opened) {
    const details = doc.getElementById(id)
    if (details && root.contains(details) && details.tagName === 'DETAILS') details.open = open
  }
  if (focus) {
    const field = doc.getElementById(focus.id)
    if (field && root.contains(field)) {
      field.focus({ preventScroll: true })
      if (focus.start !== null) {
        try {
          field.setSelectionRange(focus.start, focus.end)
        } catch {
          // Not a text field: nothing to put back.
        }
      }
    }
  }
}

// selectionStart throws on some input types (email, number); null when there is none.
function selection(field, key) {
  try {
    return typeof field[key] === 'number' ? field[key] : null
  } catch {
    return null
  }
}
