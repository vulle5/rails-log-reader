import { createContext, useState } from "react"

import { EVENTS_KEPT_CHOICES, eventsKeptFrom, LOAD_ON_OPEN_EVENTS } from "../../shared/bounds"
import { ChoiceSwitch } from "../components/ChoiceSwitch"
import { recallPreference, rememberPreference } from "../lib/preference"

/** The setting's label. */
export const EVENTS_KEPT = "Events kept"

/** What the Settings dialog says it governs, what it costs and when a change takes effect. */
export const EVENTS_KEPT_DESCRIPTION =
  "How many events the Reader loads when it opens and keeps as new ones arrive. Each Load earlier click loads at least this many more. More uses more memory. A reload loads the new amount."

/**
 * The *Events kept* figure the browser has chosen, global to it like the Theme and not keyed
 * by Rails root. Anything stored that is not one of the choices reads as the default.
 */
export function recallEventsKept() {
  return recallPreference("events-kept", LOAD_ON_OPEN_EVENTS, (stored) => eventsKeptFrom(stored) ?? LOAD_ON_OPEN_EVENTS)
}

/**
 * The figure chosen now — what the *Memory bound* holds the table to — for whatever is drawn
 * below `Reader` and says something about it.
 */
export const ChosenEventsKept = createContext(LOAD_ON_OPEN_EVENTS)

/**
 * The figure chosen, and a way to replace it that also remembers it; and `loaded`, the figure
 * it was when the Reader opened, which a choice does not change until the next reload.
 */
export type EventsKept = ReturnType<typeof useEventsKept>

export function useEventsKept() {
  const [loaded] = useState(recallEventsKept)
  const [eventsKept, setEventsKept] = useState(loaded)

  function choose(next: number) {
    setEventsKept(next)
    rememberPreference("events-kept", String(next))
  }

  return { eventsKept, loaded, choose }
}

/** The four figures as a switch, exactly one of them pressed. */
export function EventsKeptSwitch({ eventsKept, onChoose }: { eventsKept: number; onChoose: (eventsKept: number) => void }) {
  return (
    <ChoiceSwitch
      label={EVENTS_KEPT}
      choices={EVENTS_KEPT_CHOICES.map((figure) => ({
        value: String(figure),
        named: figure.toLocaleString("en"),
        title: `Keep ${figure.toLocaleString("en")} events`,
      }))}
      chosen={String(eventsKept)}
      onChoose={(choice) => onChoose(Number(choice))}
    />
  )
}
