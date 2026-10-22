import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { screen, waitFor, within } from "@testing-library/react"

import { EARLIER_BUDGET_BYTES } from "../src/shared/bounds"
import type { Earlier } from "../src/shared/earlier"
import { activityRows, column } from "./reader.harness"
import { earlierAnswers, fakeTheSidecar, fetched, openTheLiveReader, restoreTheSidecar } from "./live.harness"
import { aRun } from "./sidecar.fixtures"

/**
 * A Load earlier click through the rendered Reader over the live hook: a click is several
 * reads when what it reads only adds to rows already shown, and the strip tells the truth
 * about it from the first read to the last, failure included.
 */

beforeEach(fakeTheSidecar)

afterEach(() => {
  restoreTheSidecar()
  localStorage.clear()
})

const run = aRun("srv-1")
const NOTE = "Only added to rows already shown"
/** Where the Sidecar's history begins when the Reader attaches: further down than one click's budget reaches. */
const OPENED_AT = 100_000_000

function control() {
  return within(column("Activity table")).getByRole("button", { name: /earlier/ })
}

function note() {
  return within(column("Activity table")).queryByText(NOTE)
}

function asked() {
  return fetched.map((url) => new URL(url, "http://reader").searchParams.get("from"))
}

/** A block that only adds to the Run row the live stream already opened, ending at `from`. */
function extendsTheRun(from: number, ...more: Earlier["envelopes"]): Earlier {
  return { envelopes: [run.log(null, `before ${from}`), ...more], from }
}

/** A block holding one request older than anything shown. */
function opensARequest(from: number): Earlier {
  return { envelopes: [run.start("old", "GET", "/old"), run.finish("old")], from }
}

function aReaderWithAHistoryBehindIt() {
  const reader = openTheLiveReader()
  reader.sidecar.send(run.log(null, "booted"), run.start("req-1", "GET", "/live"), run.finish("req-1"))
  reader.sidecar.say("history", { from: OPENED_AT })
  reader.sidecar.say("loaded")
  return reader
}

describe("a click that reads more than once", () => {
  test("says it is loading from the first read to the last", async () => {
    let settle: (block: Earlier) => void = () => {}
    earlierAnswers.push(extendsTheRun(OPENED_AT - 1_000), new Promise<Earlier>((resolve) => (settle = resolve)))
    const { user } = aReaderWithAHistoryBehindIt()

    await user.click(control())
    await waitFor(() => expect(fetched).toHaveLength(2))

    expect(control()).toHaveTextContent(/^Loading earlier…$/)
    expect(control()).toBeDisabled()

    settle(opensARequest(OPENED_AT - 2_000))

    await waitFor(() => expect(control()).toHaveTextContent(/^Load earlier$/))
    expect(control()).toBeEnabled()
    expect(within(column("Activity table")).getByText("/old")).toBeInTheDocument()
    expect(asked()).toEqual([`${OPENED_AT}`, `${OPENED_AT - 1_000}`])
  })
})

describe("a click whose later read fails", () => {
  /** A click that spent its budget on rows already shown, leaving the note beside the control. */
  async function afterAClickThatOnlyExtended() {
    const reader = aReaderWithAHistoryBehindIt()
    earlierAnswers.push(extendsTheRun(OPENED_AT - EARLIER_BUDGET_BYTES - 1))
    await reader.user.click(control())
    await waitFor(() => expect(note()).toBeInTheDocument())
    return reader
  }

  test("leaves the control as it was, standing note included", async () => {
    const { user } = await afterAClickThatOnlyExtended()
    const rowsBefore = activityRows().length
    earlierAnswers.push(extendsTheRun(OPENED_AT - EARLIER_BUDGET_BYTES - 2), new Error("the read failed"))

    await user.click(control())
    await waitFor(() => expect(fetched).toHaveLength(3))
    await waitFor(() => expect(control()).toBeEnabled())

    expect(control()).toHaveTextContent(/^Load earlier$/)
    expect(note()).toBeInTheDocument()
    expect(activityRows()).toHaveLength(rowsBefore)
  })

  test("takes in what it had already read, so a retry carries on from there", async () => {
    const { user } = await afterAClickThatOnlyExtended()
    const stopped = OPENED_AT - EARLIER_BUDGET_BYTES - 2
    earlierAnswers.push(extendsTheRun(stopped), new Error("the read failed"), opensARequest(stopped - 1_000))

    await user.click(control())
    await waitFor(() => expect(control()).toBeEnabled())
    await user.click(control())

    expect(await within(column("Activity table")).findByText("/old")).toBeInTheDocument()
    expect(asked().slice(-2)).toEqual([`${stopped}`, `${stopped}`])
  })

  test("latches the Run identity of the header it had already read", async () => {
    const { user } = await afterAClickThatOnlyExtended()
    expect(document.title).not.toContain("ExampleApp")
    earlierAnswers.push(extendsTheRun(OPENED_AT - EARLIER_BUDGET_BYTES - 2, run.header()), new Error("the read failed"))

    await user.click(control())
    await waitFor(() => expect(control()).toBeEnabled())

    expect(document.title).toContain("ExampleApp")
  })

  test("asks the same question again when the first read is the one that failed", async () => {
    const { user } = aReaderWithAHistoryBehindIt()
    earlierAnswers.push(new Error("the read failed"), opensARequest(OPENED_AT - 1_000))

    await user.click(control())
    await waitFor(() => expect(control()).toBeEnabled())
    expect(control()).toHaveTextContent(/^Load earlier$/)
    await user.click(control())

    expect(await screen.findByText("/old")).toBeInTheDocument()
    expect(asked()).toEqual([`${OPENED_AT}`, `${OPENED_AT}`])
  })
})
