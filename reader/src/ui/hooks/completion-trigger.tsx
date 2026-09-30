import { useState } from "react"

import { ChoiceSwitch } from "../components/ChoiceSwitch"
import { recallPreference, rememberPreference } from "../lib/preference"

/**
 * What opens the *REPL*'s completion popover: Tab, or every word typed. Remembered, like the
 * other Settings, and anything unreadable is Tab.
 */
export type CompletionTrigger = "tab" | "typing"

/** The setting's label. */
export const COMPLETION_TRIGGER = "Completion popover"

const CHOICES: readonly { trigger: CompletionTrigger; named: string; title: string }[] = [
  { trigger: "tab", named: "On Tab", title: "Complete only when Tab is pressed" },
  { trigger: "typing", named: "As you type", title: "Offer completions as each word is typed" },
]

/** The trigger in force, and a way to replace it that also remembers it. */
export function useCompletionTrigger() {
  const [trigger, setTrigger] = useState<CompletionTrigger>(recall)

  function choose(next: CompletionTrigger) {
    setTrigger(next)
    rememberPreference("completion-trigger", next)
  }

  return { trigger, choose }
}

/** The two triggers as a switch, exactly one of them pressed. */
export function CompletionTriggerSwitch({ trigger, onChoose }: { trigger: CompletionTrigger; onChoose: (trigger: CompletionTrigger) => void }) {
  return (
    <ChoiceSwitch
      label={COMPLETION_TRIGGER}
      choices={CHOICES.map((each) => ({ value: each.trigger, named: each.named, title: each.title }))}
      chosen={trigger}
      onChoose={onChoose}
    />
  )
}

function recall(): CompletionTrigger {
  return recallPreference<CompletionTrigger>("completion-trigger", "tab", (remembered) => (remembered === "typing" ? "typing" : "tab"))
}
