import type { RubyError } from "../../../../shared/repl"

/** An error as its class, then its message when it has one, as the *Transcript* draws it. */
export function described({ className, message }: RubyError) {
  return message === "" ? className : `${className}: ${message}`
}
