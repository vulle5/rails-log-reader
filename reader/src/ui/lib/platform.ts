/** The modifier a click is held with to mean "open this elsewhere": ⌘ on macOS, Ctrl everywhere else. */
export function openModifier() {
  return /^(Mac|iPhone|iPad)/.test(navigator.platform) ? "⌘" : "Ctrl"
}
