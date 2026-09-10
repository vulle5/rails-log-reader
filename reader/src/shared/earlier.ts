import type { Envelope } from "./wire"

/**
 * What `GET /earlier` answers: the *load-earlier* contract between the two halves of the
 * Reader, which is one block of envelopes and one offset.
 *
 * The offset is the whole of the state this feature keeps, and the browser keeps it — the
 * server is the Sidecar and nothing else, so a cursor held per connection would be forgotten
 * by the reconnection `EventSource` performs on its own, and the developer would be silently
 * back where they started. It travels out with the block and comes back in with the next
 * request. `0` is the top of the file: there is nothing earlier to ask for.
 */
export type Earlier = {
  /** In append order, exactly as the live stream delivers them, and immediately before it. */
  envelopes: Envelope[]
  from: number
}
