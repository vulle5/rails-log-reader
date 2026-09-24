import { createContext, useState } from "react"

/**
 * The *Editor scheme*: a URI template with `{path}` and, optionally, `{line}` in it, or `null`
 * while none has been set. Nothing is guessed in its place.
 */

const REMEMBERED = "rails-log-reader.editor-scheme"

/** The setting's label, which is also what Settings is opened at to ask for one. */
export const EDITOR_SCHEME = "Editor scheme"

export const EDITOR_SCHEME_EXAMPLE = "vscode://file{path}:{line}"

/** The scheme in force, and a way to replace it that also remembers it. */
export function useEditorScheme() {
  const [scheme, setScheme] = useState<string | null>(recall)

  function choose(next: string | null) {
    setScheme(next)
    remember(next)
  }

  return { scheme, choose }
}

export type Editor = {
  scheme: string | null
  /** Asks the developer for a scheme, for a Source location opened while none is set. */
  requestScheme: () => void
}

export const EditorContext = createContext<Editor>({ scheme: null, requestScheme: () => {} })

type EditorSchemeFieldProps = {
  scheme: string | null
  onChoose: (scheme: string | null) => void
}

/**
 * Edited freely and committed on blur. A draft with no `{path}` is refused on blur — the
 * scheme in force stays as it was — and the error stays up until the draft is acceptable
 * again. An empty draft is acceptable: it unsets the scheme.
 */
export function EditorSchemeField({ scheme, onChoose }: EditorSchemeFieldProps) {
  const [draft, setDraft] = useState(scheme ?? "")
  const [refused, setRefused] = useState(false)
  const template = draft.trim()
  const erring = refused && !isAcceptable(template)

  function commit() {
    if (!isAcceptable(template)) {
      setRefused(true)
      return
    }
    setRefused(false)
    onChoose(template === "" ? null : template)
  }

  return (
    <>
      <input
        type="text"
        className="rounded border border-border bg-background px-2 py-0.75 font-mono text-sm text-foreground focus:outline-2 focus:-outline-offset-1 focus:outline-accent/50 aria-invalid:border-error"
        aria-label={EDITOR_SCHEME}
        aria-invalid={erring || undefined}
        aria-errormessage={erring ? "editor-scheme-error" : undefined}
        spellCheck={false}
        autoComplete="off"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
      {erring && (
        <p id="editor-scheme-error" className="text-xs text-error" role="alert">
          Needs {"{path}"} where the file goes — not saved.
        </p>
      )}
    </>
  )
}

function isAcceptable(template: string) {
  return template === "" || template.includes("{path}")
}

/**
 * `localStorage` throws outright with site data blocked. That, anything absent, and anything
 * stored with no `{path}` in it are all unset.
 */
function recall(): string | null {
  try {
    const remembered = window.localStorage.getItem(REMEMBERED)
    return remembered?.includes("{path}") ? remembered : null
  } catch {
    return null
  }
}

function remember(scheme: string | null) {
  try {
    if (scheme === null) window.localStorage.removeItem(REMEMBERED)
    else window.localStorage.setItem(REMEMBERED, scheme)
  } catch {
    // The scheme still applies for this session.
  }
}
