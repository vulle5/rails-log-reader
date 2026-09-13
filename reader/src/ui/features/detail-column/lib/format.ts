/** What the wire's `truncated` map counts in: bytes below 1 KB, rounded KB above it — the
 * unit a developer sizes a log line in, not the one a cut count arrives in. */
export function bytes(howMany: number) {
  return howMany < 1024 ? `${howMany} bytes` : `${Math.round(howMany / 1024)} KB`
}
