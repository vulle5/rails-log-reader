import type { RequestException } from "../../../../shared/wire"
import { bytes } from "./format"

/**
 * What the Exception block's copy control puts on the clipboard: the same facts the block
 * renders, with none of the reasons they render the way they do. `<class>: <message>` on the
 * first line, one backtrace frame per line, real newlines — no severity labels, no markup —
 * so it pastes cleanly into a bug tracker, a colleague's chat, or an AI assistant.
 *
 * `cutFrom` repeats the on-screen `.cut` note's own wording, `#`-prefixed so a paste can
 * never be mistaken for one more real frame: the whole promise of this text is that it is
 * either the whole trace or it says so, never a trace quietly missing its tail.
 */
export function exceptionText(exception: RequestException, cutFrom: number | null): string {
  const lines = [`${exception.class}: ${exception.message}`, ...exception.backtrace]
  if (cutFrom !== null) lines.push(`# backtrace was cut by the Sidecar — ${bytes(cutFrom)} was emitted`)
  return lines.join("\n")
}
