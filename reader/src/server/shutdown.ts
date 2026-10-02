const steps: (() => void)[] = []

/**
 * Runs `step` once as the Reader stops: when it exits, and when SIGINT, SIGTERM or SIGHUP stops
 * it. A signal ends the process without `exit` listeners, so each signal runs every step itself
 * and is then raised again, to end the process as it would have.
 */
export function onShutdown(step: () => void) {
  if (steps.length === 0) {
    process.on("exit", runSteps)
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(signal, () => {
        runSteps()
        process.kill(process.pid, signal)
      })
    }
  }
  steps.push(step)
}

function runSteps() {
  for (const step of steps.splice(0)) step()
}
