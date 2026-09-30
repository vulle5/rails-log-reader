import { useState } from "react"

import { ChoiceSwitch } from "../components/ChoiceSwitch"
import { recallPreference, rememberPreference } from "../lib/preference"

/** The setting's label. */
export const HISTORY_SUGGESTION = "History suggestion"

const CHOICES: readonly { value: "on" | "off"; named: string; title: string }[] = [
  { value: "on", named: "On", title: "Offer the newest matching input from the history as grey text" },
  { value: "off", named: "Off", title: "Offer no history suggestion" },
]

/**
 * Whether the *REPL*'s input offers the *History suggestion*, and a way to set it that also
 * remembers it. Remembered as what is off, like the other Settings, so anything unreadable is on.
 */
export function useHistorySuggestion() {
  const [on, setOn] = useState(recall)

  function choose(next: boolean) {
    setOn(next)
    rememberPreference("history-suggestion", next ? null : "off")
  }

  return { on, choose }
}

/** The two choices as a switch, exactly one of them pressed. */
export function HistorySuggestionSwitch({ on, onChoose }: { on: boolean; onChoose: (on: boolean) => void }) {
  return <ChoiceSwitch label={HISTORY_SUGGESTION} choices={CHOICES} chosen={on ? "on" : "off"} onChoose={(choice) => onChoose(choice === "on")} />
}

function recall() {
  return recallPreference("history-suggestion", true, (stored) => stored !== "off")
}
