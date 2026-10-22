import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { screen, within } from "@testing-library/react"

import { activityRows, consoleLines } from "./reader.harness"
import { bigRequests, chooseEventsKept, fakeTheSidecar, fetched, FakeSidecar, openTheLiveReader, restoreTheSidecar } from "./live.harness"

/**
 * Changing Events kept in Settings, through the rendered Reader over the live hook: the
 * Activity table and the Console move the moment the figure does, and nothing is read.
 */

const EVENTS_KEPT = "rails-log-reader.events-kept"

beforeEach(fakeTheSidecar)

afterEach(() => {
  restoreTheSidecar()
  localStorage.clear()
})

function paths() {
  return activityRows().map((row) => within(row).getByText(/^\/page\//).textContent)
}

function sayings() {
  return consoleLines().map((line) => line.textContent ?? "")
}

describe("choosing a lower Events kept", () => {
  test("removes the evicted rows from the Activity table and their lines from the Console", async () => {
    localStorage.setItem(EVENTS_KEPT, "10000")
    const { user, sidecar } = openTheLiveReader()
    // A hundred requests of a hundred events: exactly what 10,000 keeps.
    sidecar.send(...bigRequests(0, 100))
    sidecar.say("loaded")
    expect(paths()).toHaveLength(100)
    expect(sayings().some((saying) => saying.includes("line of page 0"))).toBe(true)

    await chooseEventsKept(user, "5,000")

    expect(paths()).toHaveLength(50)
    expect(paths().at(0)).toBe("/page/50")
    expect(sayings().some((saying) => saying.includes("line of page 49"))).toBe(false)
    expect(sayings().some((saying) => saying.includes("line of page 50"))).toBe(true)
    expect(consoleLines()).toHaveLength(50)
  })

  test("fetches nothing, and keeps the stream it opened with the figure the page loaded with", async () => {
    localStorage.setItem(EVENTS_KEPT, "10000")
    const { user, sidecar } = openTheLiveReader()
    sidecar.send(...bigRequests(0, 100))

    await chooseEventsKept(user, "5,000")

    expect(fetched).toEqual([])
    expect(FakeSidecar.opened.map((opened) => opened.url)).toEqual(["/events?events=10000"])
  })
})

describe("Load earlier after a change", () => {
  test("reads at least the figure chosen now, not the one the page loaded with", async () => {
    const { user, sidecar } = openTheLiveReader()
    sidecar.send(...bigRequests(0, 5))
    sidecar.say("history", { from: 4_096 })
    sidecar.say("loaded")

    await chooseEventsKept(user, "25,000")
    await user.click(screen.getByRole("button", { name: /earlier/ }))

    const [asked, ...others] = fetched
    expect(others).toEqual([])
    expect(new URL(asked ?? "", "http://reader").searchParams.get("events")).toBe("25000")
  })
})

describe("choosing a higher Events kept", () => {
  test("stops eviction at once, until the table reaches the new figure", async () => {
    const { user, sidecar } = openTheLiveReader()
    sidecar.send(...bigRequests(0, 50))
    sidecar.say("loaded")

    await chooseEventsKept(user, "10,000")
    sidecar.send(...bigRequests(50, 20))

    expect(paths()).toHaveLength(70)
    expect(paths().at(0)).toBe("/page/0")
  })
})
