/**
 * One of a few choices as a row of buttons, exactly one of them pressed. Styled as the Activity
 * table's row-kind tabs are, because it is the same kind of control.
 */
export function ChoiceSwitch<Value extends string>({
  label,
  choices,
  chosen,
  onChoose,
}: {
  label: string
  choices: readonly { value: Value; named: string; title: string }[]
  chosen: Value
  onChoose: (value: Value) => void
}) {
  return (
    <div className="flex flex-none gap-0.5" role="group" aria-label={label}>
      {choices.map((each) => (
        <button
          key={each.value}
          type="button"
          className="cursor-pointer rounded border border-transparent bg-transparent px-2 py-0.5 text-xs text-muted hover:bg-raised aria-pressed:border-border aria-pressed:bg-selected aria-pressed:text-foreground aria-pressed:hover:bg-raised"
          aria-pressed={each.value === chosen}
          title={each.title}
          onClick={() => onChoose(each.value)}
        >
          {each.named}
        </button>
      ))}
    </div>
  )
}
