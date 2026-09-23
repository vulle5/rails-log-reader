import { createContext, useContext, useEffect, useId, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react"

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

/** The trigger's and the Close button's look: one kind of quiet control, in the bar and in the dialog. */
const QUIET_BUTTON =
  "cursor-pointer rounded border border-border bg-transparent px-2 py-0.5 text-xs text-muted hover:bg-raised hover:text-foreground"

/**
 * A trigger for the reader bar and the native `<dialog>` it opens modally. A click closes it
 * only when both its press and its release were on the dialog's own box, which has no padding
 * or border of its own — the panel fills it exactly — so it shows nowhere but the backdrop,
 * and a selection dragged out of the field and released over the backdrop leaves it open.
 *
 * The dialog grows in and fades on open, and back out on close; `display` and `overlay`
 * transition discretely so a closing dialog stays in the top layer until its fade has
 * finished. The backdrop dims and only lightly blurs the columns, so a Theme change is still
 * seen repainting them.
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
      <button type="button" className={QUIET_BUTTON} onClick={() => open()}>
        Settings
      </button>
      <dialog
        ref={dialog}
        // The blur is 1px so the columns behind stay legible.
        className={[
          "m-auto w-110 rounded-md bg-transparent text-foreground shadow-dialog",
          "scale-96 opacity-0 open:scale-100 open:opacity-100 starting:open:scale-96 starting:open:opacity-0",
          "backdrop:bg-backdrop backdrop:opacity-0 backdrop:backdrop-blur-[1px] open:backdrop:opacity-100 starting:open:backdrop:opacity-0",
          "transition-[opacity,scale,display,overlay] transition-discrete duration-140 ease-out motion-reduce:transition-none",
          "backdrop:transition-[opacity,display,overlay] backdrop:transition-discrete backdrop:duration-140 backdrop:ease-out motion-reduce:backdrop:transition-none",
        ].join(" ")}
        aria-label="Settings"
        onClose={() => setTargeted(null)}
        onMouseDown={(event) => {
          pressedOn.current = event.target
        }}
        onClick={(event) => {
          if (event.target === dialog.current && pressedOn.current === dialog.current) dialog.current.close()
        }}
      >
        <div className="rounded-md border border-border bg-raised px-4 pt-3 pb-4 text-sm">
          <header className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold">Settings</h2>
            <button type="button" className={QUIET_BUTTON} onClick={() => dialog.current?.close()}>
              Close
            </button>
          </header>
          <Targeted value={targeted}>
            <ul className="flex flex-col gap-3.5">{children}</ul>
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

/**
 * Focuses its first control when the dialog is opened at it — after `showModal`'s own focusing.
 * Named by its label and described by its description, so each setting reads as one unit.
 */
export function Setting({ label, description, children }: SettingProps) {
  const targeted = useContext(Targeted) === label
  const control = useRef<HTMLDivElement>(null)
  const id = useId()

  useEffect(() => {
    if (targeted) control.current?.querySelector<HTMLElement>("input, button, select, textarea")?.focus()
  }, [targeted])

  return (
    // Outlined where the dialog was opened at, until it closes.
    <li
      className="flex flex-col gap-1 data-targeted:rounded data-targeted:outline-2 data-targeted:outline-offset-6 data-targeted:outline-accent"
      aria-labelledby={`${id}-label`}
      aria-describedby={description === undefined ? undefined : `${id}-description`}
      data-targeted={targeted ? "" : undefined}
    >
      <span className="font-semibold text-muted" id={`${id}-label`}>
        {label}
      </span>
      <div className="flex flex-col gap-1" ref={control}>
        {children}
      </div>
      {description !== undefined && (
        <p className="text-xs leading-relaxed text-faint" id={`${id}-description`}>
          {description}
        </p>
      )}
    </li>
  )
}
