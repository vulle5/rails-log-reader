import { act, render } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Earlier } from "../src/shared/earlier"
import type { Envelope } from "../src/shared/wire"
import { aRun } from "./sidecar.fixtures"
import { useEventsKept } from "../src/ui/hooks/events-kept"
import { useSidecar } from "../src/ui/hooks/live"
import { Reader } from "../src/ui/Reader"

/**
 * The Reader over the live hook, as `main.tsx` mounts it, with the Sidecar's stream and the
 * `fetch` for earlier history taken out: what a test sends down the stream is what the server
 * would, and what the Reader asks of the server is written down instead of answered.
 */

/** One `EventSource` the Reader opened, and the way for a test to speak down it. */
export class FakeSidecar {
  static opened: FakeSidecar[] = []

  onmessage: ((message: MessageEvent) => void) | null = null
  private readonly listeners = new Map<string, ((message: MessageEvent) => void)[]>()
  closed = false

  constructor(readonly url: string) {
    FakeSidecar.opened.push(this)
  }

  addEventListener(type: string, listener: (message: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close() {
    this.closed = true
  }

  /** One message's worth of envelopes, as the server sends a batch. */
  send(...envelopes: Envelope[]) {
    act(() => this.onmessage?.({ data: JSON.stringify(envelopes) } as MessageEvent))
  }

  /** The server's own events: `history` (where the history begins) and `loaded`. */
  say(type: string, data: unknown = {}) {
    act(() => this.listeners.get(type)?.forEach((listener) => listener({ data: JSON.stringify(data) } as MessageEvent)))
  }
}

const real = { EventSource: globalThis.EventSource, fetch: globalThis.fetch }

/** Every URL the Reader fetched while a sidecar was faked. */
export const fetched: string[] = []

/**
 * What the next `/earlier` fetches answer, one entry each and in order: a block, a failure, or
 * a promise a test settles itself. A fetch with none left answers an empty block at the top.
 */
export const earlierAnswers: (Earlier | Error | Promise<Earlier>)[] = []

export function fakeTheSidecar() {
  FakeSidecar.opened = []
  fetched.length = 0
  earlierAnswers.length = 0
  globalThis.EventSource = FakeSidecar as unknown as typeof EventSource
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input))
    const answer = earlierAnswers.shift() ?? { envelopes: [], from: 0 }
    if (answer instanceof Error) throw answer
    return new Response(JSON.stringify(await answer))
  }) as typeof fetch
}

export function restoreTheSidecar() {
  globalThis.EventSource = real.EventSource
  globalThis.fetch = real.fetch
}

const run = aRun("srv-1")

/**
 * `count` requests from `/page/<from>` on, a hundred events each, one of them the App log
 * line `line of page <n>`: a hundred of them are what 10,000 events keeps.
 */
export function bigRequests(from: number, count: number): Envelope[] {
  return Array.from({ length: count }, (_, at) => {
    const index = from + at
    const id = `req-${index}`
    return [
      run.start(id, "GET", `/page/${index}`),
      run.log(id, `line of page ${index}`),
      ...Array.from({ length: 97 }, () => run.sql(id)),
      run.finish(id),
    ]
  }).flat()
}

/** `main.tsx`'s composition of the pieces this seam is about: the chosen figure, the hook, the Reader. */
function Live() {
  const eventsKept = useEventsKept()
  const { rows, lines, evictedRows, evictedEvaluations, historyLoaded, earlier, loadEarlier, identity } = useSidecar(eventsKept)

  return (
    <Reader
      rows={rows}
      lines={lines}
      evictedRows={evictedRows}
      evictedEvaluations={evictedEvaluations}
      earlier={earlier}
      onLoadEarlier={loadEarlier}
      historyLoaded={historyLoaded}
      eventsKept={eventsKept}
      appName={identity?.appName ?? null}
    />
  )
}

/** The live Reader, attached to its (single) stream, and a user to drive it with. */
export function openTheLiveReader() {
  const user = userEvent.setup()
  const view = render(<Live />)
  const [sidecar] = FakeSidecar.opened
  if (sidecar === undefined) throw new Error("the live Reader never opened its stream")
  return { user, sidecar, ...view }
}
