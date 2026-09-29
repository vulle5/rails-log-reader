import { useLayoutEffect, useRef } from "react"

import type { Outcome, TranscriptEntry } from "../../../../shared/repl"

/** How near its end the Transcript can be scrolled and still follow what arrives. */
const FOLLOWING_SLACK = 24

/**
 * The *REPL*'s *Transcript*: each evaluation's input, then what it printed, then its result or
 * its error, with what the console process printed outside any evaluation as entries of their
 * own. Scrolled to its end as entries arrive and grow, unless it was scrolled up away from it.
 */
export function Transcript({ entries }: { entries: readonly TranscriptEntry[] }) {
  const list = useRef<HTMLOListElement>(null)
  const following = useRef(true)

  useLayoutEffect(() => {
    const element = list.current
    if (element !== null && following.current) element.scrollTop = element.scrollHeight
  }, [entries])

  function scrolled() {
    const element = list.current
    if (element !== null) following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOWING_SLACK
  }

  return (
    <ol
      className="flex min-h-0 flex-auto flex-col gap-2 overflow-auto px-3 py-2 font-mono text-sm"
      aria-label="Transcript"
      ref={list}
      onScroll={scrolled}
    >
      {entries.map((entry) => (
        <li key={entry.id}>
          {entry.kind === "evaluation" ? (
            <>
              <pre className="break-words whitespace-pre-wrap text-strong">
                <span className="text-faint select-none" aria-hidden="true">
                  {"› "}
                </span>
                {entry.input}
              </pre>
              <Printed output={entry.output} cut={entry.outputCut} />
              {entry.outcome !== null && <Answer outcome={entry.outcome} />}
            </>
          ) : (
            <Printed output={entry.output} cut={entry.outputCut} />
          )}
        </li>
      ))}
    </ol>
  )
}

function Printed({ output, cut }: { output: string; cut: boolean }) {
  if (output === "") return null

  return (
    <>
      <pre className="break-words whitespace-pre-wrap text-muted">{output}</pre>
      {cut && <Cut>Output cut at 64 KB</Cut>}
    </>
  )
}

function Answer({ outcome }: { outcome: Outcome }) {
  switch (outcome.kind) {
    case "result":
      return (
        <>
          <pre className="break-words whitespace-pre-wrap">
            <span className="text-faint select-none" aria-hidden="true">
              {"=> "}
            </span>
            {outcome.text}
          </pre>
          {outcome.cut && <Cut>Result cut at 64 KB</Cut>}
        </>
      )
    case "error":
      return (
        <pre className="break-words whitespace-pre-wrap text-error">
          {outcome.className}: {outcome.message}
        </pre>
      )
    case "lost":
      return <p className="font-ui text-error">The REPL exited before it answered.</p>
  }
}

function Cut({ children }: { children: string }) {
  return <p className="font-ui text-xs text-faint">{children}</p>
}
