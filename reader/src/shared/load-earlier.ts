import type { ActivityTable, EvictedRow } from "./activity"
import type { Earlier } from "./earlier"
import type { Envelope } from "./wire"

/**
 * Reads the block of history before `from`, at least `events` events of it, and no more
 * than `budget` bytes of the file when it would take more to finish what it left split. The
 * browser's is a `fetch` of `GET /earlier`; a test's is the server's backward scan itself.
 */
export type ReadBlock = (from: number, events: number, budget: number) => Promise<Earlier>

export type LoadEarlierOptions = {
  /** The fold the block is folded into. */
  activity: Pick<ActivityTable, "foldEarlier">
  readBlock: ReadBlock
  /** The offset the history held so far begins at: `0` is the top of the file. */
  from: number
  /** The *Memory bound*'s figure: how many events a block reads at least. */
  events: number
  /** How many bytes of the file the whole click may read, across every block it reads. */
  budget: number
}

export type LoadedEarlier = {
  /** Where the history held begins now. */
  from: number
  /** Every envelope the click read, for whatever has to learn from them beside the fold. */
  envelopes: readonly Envelope[]
  /** Every row the click evicted, which the *Console* has to let go of the lines of. */
  evicted: readonly EvictedRow[]
  /**
   * How many rows the click opened above the table's oldest. `0` with `reachedStart` false
   * means the budget ran out first: everything the click read only extended rows already shown.
   */
  opened: number
  /** Whether the history now begins at the top of the file: there is nothing earlier left. */
  reachedStart: boolean
  /**
   * A read failed before the click was done. Everything above is still true of the blocks read
   * before it: they are folded, `from` is where the last of them began, and a retry asks for
   * what comes before that.
   */
  failed: boolean
}

/**
 * One *Load earlier* click: reads the block before `from` and folds it as what it is —
 * everything in it happened before everything the fold holds, so its rows open above them.
 * A block that only extended rows already shown is not a result, so the click reads on from
 * where that block began until a row opens, the top of the file is reached or the budget is
 * spent. A block that begins no earlier than the one before it has nothing left to give, and
 * ends the click too. A read that fails ends the click with `failed`, having kept whatever the
 * reads before it folded. The browser's live hook and the Sidecar-to-table test harness both run this, so what
 * the tests exercise is the click itself.
 */
export async function loadEarlier({ activity, readBlock, from, events, budget }: LoadEarlierOptions): Promise<LoadedEarlier> {
  const envelopes: Envelope[] = []
  const evicted: EvictedRow[] = []
  let opened = 0
  let position = from
  let failed = false

  do {
    let block: Earlier
    try {
      block = await readBlock(position, events, budget - (from - position))
    } catch {
      failed = true
      break
    }

    const folded = activity.foldEarlier(block.envelopes)

    envelopes.push(...block.envelopes)
    evicted.push(...folded.evicted)
    opened += folded.opened
    const progressed = block.from < position
    position = Math.min(position, block.from)
    if (!progressed) break
  } while (opened === 0 && position > 0 && from - position < budget)

  return { from: position, envelopes, evicted, opened, reachedStart: position === 0, failed }
}
