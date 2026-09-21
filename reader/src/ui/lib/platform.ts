function onMac() {
  return /^(Mac|iPhone|iPad)/.test(navigator.platform)
}

/** The modifier a click is held with to mean "open this elsewhere": ⌘ on macOS, Ctrl everywhere else. */
export function openModifier() {
  return onMac() ? "⌘" : "Ctrl"
}

/** `openModifier`'s own `KeyboardEvent.key`. */
export function openModifierKey() {
  return onMac() ? "Meta" : "Control"
}

/** Whether `event` was made with `openModifier` held. */
export function withOpenModifier(event: { metaKey: boolean; ctrlKey: boolean }) {
  return onMac() ? event.metaKey : event.ctrlKey
}
