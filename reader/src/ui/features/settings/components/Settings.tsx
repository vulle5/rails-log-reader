import { useRef, type ReactNode } from "react"

type SettingsProps = {
  children: ReactNode
}

/**
 * A trigger for the reader bar and the native `<dialog>` it opens modally. A click closes it
 * only when both its press and its release were on the dialog's own box, which the stylesheet
 * leaves showing nowhere but the backdrop — so a selection dragged out of the field and
 * released over the backdrop leaves it open.
 */
export function Settings({ children }: SettingsProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const pressedOn = useRef<EventTarget | null>(null)

  return (
    <>
      <button type="button" className="settings-trigger" onClick={() => dialog.current?.showModal()}>
        Settings
      </button>
      <dialog
        ref={dialog}
        className="settings"
        aria-label="Settings"
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
          <ul className="settings-list">{children}</ul>
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

export function Setting({ label, description, children }: SettingProps) {
  return (
    <li className="setting">
      <span className="setting-label">{label}</span>
      <div className="setting-control">{children}</div>
      {description !== undefined && <p className="setting-description">{description}</p>}
    </li>
  )
}
