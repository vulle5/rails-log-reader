import type { NoBody, ResponsePayload } from "../../../../shared/wire"
import { mediaType } from "./format"

/** A Response event's payload with no body, and the reason why. */
export type NoBodyPayload = ResponsePayload & { no_body: NoBody }

/** Whether the app took the connection, leaving no headers and no body to read. */
export function isHijacked(payload: ResponsePayload) {
  return "no_body" in payload && payload.no_body.reason === "hijacked"
}

/**
 * The word the Response tab's label carries for a response with no body: the type's short
 * name, the status of an empty one, the encoding, `stream`, or `ws` for a hijacked connection.
 * A response that named no type has none.
 */
export function noBodyHint(payload: NoBodyPayload) {
  const noBody = payload.no_body
  switch (noBody.reason) {
    case "type": {
      const type = mediaType(payload.content_type)
      return type === null ? undefined : shortName(type)
    }
    case "streamed":
      return "stream"
    case "encoded":
      return noBody.content_encoding
    case "empty":
      return String(payload.status)
    case "hijacked":
      return "ws"
  }
}

/** `text/html` as `html`, `application/x-yaml` as `yaml`, `application/vnd.ms-excel` as `ms-excel`. */
function shortName(type: string) {
  const subtype = type.slice(type.indexOf("/") + 1)
  return subtype.replace(/^(x-|vnd\.)/, "")
}

/** What a response is, as a person names it: "an HTML page", "a PNG image". */
export function kindOf(contentType: string | null) {
  const type = mediaType(contentType)
  if (type === null) return "a body with no content type"
  if (type === "text/html") return "an HTML page"
  if (type === "application/pdf") return "a PDF"
  if (type === "text/csv") return "a CSV file"
  if (type === "text/plain") return "plain text"
  if (type.startsWith("image/")) return `a ${shortName(type).toUpperCase()} image`
  return `a file of type ${type}`
}
