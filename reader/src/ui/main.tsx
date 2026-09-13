import { createRoot } from "react-dom/client"

import { detectEmptyState, detectMismatch } from "../shared/initializer-status"
import { useInitializerFileStatus, useInitializerRepair } from "./features/setup-status/lib/initializer-repair"
import { useSidecar } from "./hooks/live"
import { Reader } from "./Reader"

const container = document.getElementById("root")
if (container === null) throw new Error("index.html is missing its #root element")

/**
 * The one place the Sidecar is subscribed to, so every component below is a pure render.
 * `useInitializerFileStatus` and `useInitializerRepair` own the fetch to `GET
 * /initializer-status` and the `POST /initializer-repair` that follows a click, and
 * `detectMismatch` folds the file status together with whatever `v` the live Sidecar last
 * reported into the one thing `Reader` actually renders. `detectEmptyState` folds the same
 * file status, with whether the Sidecar's history has all arrived, into why an empty Reader
 * is empty.
 */
function LiveReader() {
  const { rows, lines, evictedRows, liveWireVersion, liveRunId, historyLoaded, earlier, loadEarlier } = useSidecar()
  const { status: fileStatus, markRepaired } = useInitializerFileStatus()
  const { state: repairState, repair, dismiss } = useInitializerRepair(liveRunId)

  async function onRepair() {
    const copied = await repair()
    // A `POST` that resolved `ok` is a write this same process just made: the Reader wrote
    // the master copy's own bytes to that path, so there is nothing left to learn by reading
    // it back, and no round trip stands between the click and the banner correctly reading
    // the file as current while it waits on the restart that repairs the process.
    if (copied) markRepaired()
  }

  return (
    <Reader
      rows={rows}
      lines={lines}
      evictedRows={evictedRows}
      mismatch={detectMismatch(fileStatus, liveWireVersion)}
      liveWireVersion={liveWireVersion}
      repairState={repairState}
      onRepair={onRepair}
      onDismissRepair={dismiss}
      earlier={earlier}
      onLoadEarlier={loadEarlier}
      emptyState={detectEmptyState(fileStatus, historyLoaded)}
    />
  )
}

createRoot(container).render(<LiveReader />)
