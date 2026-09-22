import { createContext, useContext, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react"

export type SettingsHandle = {
  /** Opens the dialog, and at `setting` — a `Setting`'s label — focused and outlined, if named. */
  open: (setting?: string) => void
}

type SettingsProps = {
  children: ReactNode
  ref?: Ref<SettingsHandle>
}

/** The label of the setting the dialog was opened at, until the dialog closes. */
const Targeted = createContext<string | null>(null)

/**
 * A trigger for the reader bar and the native `<dialog>` it opens modally. A click closes it
 * only when both its press and its release were on the dialog's own box, which the stylesheet
 * leaves showing nowhere but the backdrop — so a selection dragged out of the field and
 * released over the backdrop leaves it open.
 */
export function Settings({ children, ref }: SettingsProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const pressedOn = useRef<EventTarget | null>(null)
  const [targeted, setTargeted] = useState<string | null>(null)

  function open(setting: string | null = null) {
    setTargeted(setting)
    dialog.current?.showModal()
  }

  useImperativeHandle(ref, () => ({ open }), [])

  return (
    <>
      <button type="button" className="settings-trigger" onClick={() => open()}>
        Settings
      </button>
      <dialog
        ref={dialog}
        className="settings"
        aria-label="Settings"
        onClose={() => setTargeted(null)}
        onMouseDown={(event) => {
          pressedOn.current = event.target
        }}
        onClick={(event) => {
          if (event.target === dialog.current && pressedOn.current === dialog.current) dialog.current.close()
        }}
      >
        <div className="settings-panel">
          <header className="settings-heading">
            <h2>Settings</h2>
            <button type="button" className="settings-close" onClick={() => dialog.current?.close()}>
              Close
            </button>
          </header>
          <Targeted value={targeted}>
            <ul className="settings-list">{children}</ul>
          </Targeted>
        </div>
      </dialog>
    </>
  )
}

type SettingProps = {
  label: string
  /** One always-visible line under the control. */
  description?: ReactNode
  children: ReactNode
}

/** Focuses its first control when the dialog is opened at it — after `showModal`'s own focusing. */
export function Setting({ label, description, children }: SettingProps) {
  const targeted = useContext(Targeted) === label
  const control = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (targeted) control.current?.querySelector<HTMLElement>("input, button, select, textarea")?.focus()
  }, [targeted])

  return (
    <li className={targeted ? "setting setting-targeted" : "setting"}>
      <span className="setting-label">{label}</span>
      <div className="setting-control" ref={control}>
        {children}
      </div>
      {description !== undefined && <p className="setting-description">{description}</p>}
    </li>
  )
}
