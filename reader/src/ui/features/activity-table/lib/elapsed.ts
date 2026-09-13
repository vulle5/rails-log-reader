import { useEffect, useState } from "react"

import type { ProvenElapsed } from "../../../../shared/activity"

/**
 * The climbing half of an in-flight request's elapsed time.
 *
 * The fold can only prove how long a request had been running as of the last event it saw
 * for it — within one Run's own `at_mono`, the only clock two events may be subtracted
 * across. A hanging request emits nothing, which is exactly when the number matters, so the
 * proof has to be carried forward from where it was taken: the `at_wall` that event landed
 * with, plus the time the browser's own clock has counted since.
 *
 * **This is the one place `at_wall` is subtracted**, and the rule it keeps is the real one:
 * never against another `at_wall`. Two of them are two processes' opinions and may disagree
 * by an NTP step in either direction, which is why nothing is ordered by them, ever. One of
 * them against the local clock is a different question — *how long ago was this line
 * written* — asked on the one machine that wrote it and is reading it, which is the whole
 * premise of a strictly local tool. It is display-grade by construction, and only ever
 * exposed for the stretch since the last event: everything the file covers is measured in
 * `at_mono` and immune.
 *
 * The alternative was anchoring on the moment this component mounted, which reads correctly
 * while you watch a request hang and lies by the whole of the wait when you open the Reader
 * on one already hanging — the single case the pill exists for.
 *
 * Nothing here is a threshold: no colour changes, nothing expires, and there is no timeout,
 * ever. It is a number that climbs, and the human draws the conclusion.
 */
export function useClimbingElapsed(proven: ProvenElapsed | null, climbing: boolean) {
  // Ten a second, which is what makes a tenth-of-a-second pill visibly climb — and only
  // while something is climbing, so a table of finished requests holds no timer at all. One
  // per in-flight row, deliberately: the alternative is a tick on the whole table, and at
  // the Memory bound's rows that is five thousand re-renders a tenth of a second.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!climbing) return

    const tick = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(tick)
  }, [climbing])

  if (proven === null) return null
  // Frozen: an *Interrupted* request stopped running when its Run did, and the last thing
  // either of them said is where the number belongs.
  if (!climbing) return proven.ms

  // A clock stepped forward between the event and now would push this backwards, and a
  // negative stretch is the one reading that would be nonsense rather than merely imprecise.
  return proven.ms + Math.max(now - proven.atWall, 0)
}
