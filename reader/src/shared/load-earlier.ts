import type { ActivityTable, EvictedRow } from "./activity"
import type { Earlier } from "./earlier"
import type { Envelope } from "./wire"

/**
 * Reads the block of history before `from`, at least `events` events of it. The browser's
 * is a `fetch` of `GET /earlier`; a test's is the server's backward scan itself.
 */
export type ReadBlock = (from: number, events: number) => Promise<Earlier>

export type LoadEarlierOptions = {
  /** The fold the block is folded into. */
  activity: Pick<ActivityTable, "foldEarlier">
  readBlock: ReadBlock
  /** The offset the history held so far begins at: `0` is the top of the file. */
  from: number
  /** The *Memory bound*'s figure: how many events a block reads at least. */
  events: number
}

export type LoadedEarlier = {
  /** Where the history held begins now. */
  from: number
  /** Every envelope the click read, for whatever has to learn from them beside the fold. */
  envelopes: readonly Envelope[]
  /** Every row the click evicted, which the *Console* has to let go of the lines of. */
  evicted: readonly EvictedRow[]
  /** How many rows the click opened above the table's oldest. */
  opened: number
  /** Whether the history now begins at the top of the file: there is nothing earlier left. */
  reachedStart: boolean
}

/**
 * One *Load earlier* click: reads the block before `from` and folds it as what it is —
 * everything in it happened before everything the fold holds, so its rows open above them.
 * The browser's live hook and the Sidecar-to-table test harness both run this, so what the
 * tests exercise is the click itself.
 */
export async function loadEarlier({ activity, readBlock, from, events }: LoadEarlierOptions): Promise<LoadedEarlier> {
  const block = await readBlock(from, events)
  const folded = activity.foldEarlier(block.envelopes)

  return {
    from: block.from,
    envelopes: block.envelopes,
    evicted: folded.evicted,
    opened: folded.opened,
    reachedStart: block.from === 0,
  }
}
