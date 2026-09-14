import { useEffect, useState } from "react"

/**
 * `GET /app-name-override`, fetched once on mount — the same idiom `useInitializerFileStatus`
 * uses for `/initializer-status`, minus the re-read on focus: that read exists because the
 * files it asks about can change while the tab is unfocused, and `RAILS_LOG_READER_APP_NAME`
 * cannot — it was read once by the Bun server at its own startup, before this tab ever opened.
 *
 * `null` both before the fetch has answered and once it has said there is no override, which
 * `resolveAppName` treats the same way: nothing here to beat the wire's own name with.
 */
export function useAppNameOverride() {
  const [override, setOverride] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    fetch("/app-name-override")
      .then((response) => response.json() as Promise<{ override: string | null }>)
      .then((body) => {
        if (!cancelled) setOverride(body.override)
      })
      .catch(() => {
        // Left as null: a failed read is nothing to override with, the same as one never made.
      })

    return () => {
      cancelled = true
    }
  }, [])

  return override
}
