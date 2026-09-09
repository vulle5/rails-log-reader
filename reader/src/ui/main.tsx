import { createRoot } from "react-dom/client"

import { detectMismatch } from "../shared/initializer-status"
import { useInitializerFileStatus, useInitializerRepair } from "./initializer-repair"
import { useSidecar } from "./live"
import { Reader } from "./Reader"

const container = document.getElementById("root")
if (container === null) throw new Error("index.html is missing its #root element")

/**
 * The one place the Sidecar is subscribed to, so every component below is a pure render.
 * `useInitializerFileStatus` and `useInitializerRepair` are the same idea for #29: the fetch
 * to `GET /initializer-status` and the `POST /initializer-repair` that follows a click both
 * live here, and `detectMismatch` folds the file status together with whatever `v` the live
 * Sidecar last reported into the one thing `Reader` actually renders.
 */
function LiveReader() {
  const { rows, lines, liveWireVersion, liveRunId } = useSidecar()
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
      mismatch={detectMismatch(fileStatus, liveWireVersion)}
      liveWireVersion={liveWireVersion}
      repairState={repairState}
      onRepair={onRepair}
      onDismissRepair={dismiss}
    />
  )
}

createRoot(container).render(<LiveReader />)
